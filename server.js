const express = require('express');
const { Pool } = require('pg');
const vision = require('@google-cloud/vision');
const axios = require('axios');
const cron = require('node-cron');
const cors = require('cors');

// Force the internal runtime engine into Gulf Standard Time globally
process.env.TZ = 'Asia/Dubai';

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());

// --- DATABASE CONNECTION CONFIGURATION ---
const dbPool = new Pool({ connectionString: process.env.DATABASE_URL });

// Initialize database timezone controls on server launch
dbPool.query("ALTER DATABASE postgres SET timezone TO 'Asia/Dubai';")
    .then(() => console.log("Supabase database timezone standard successfully synchronized to GST."))
    .catch(err => console.error("Database timezone initialization error:", err.message));

let visionClient = null;
try {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        visionClient = new vision.ImageAnnotatorClient({ 
            credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS) 
        });
    }
} catch(e) {
    console.error("Vision API initialization suspended, check credential syntax:", e.message);
}

const FRESHSALES_URL = `https://${process.env.FRESHSALES_DOMAIN}.freshsales.io/api/contacts`;
const FRESHSALES_HEADERS = { 
    'Authorization': `Token token=${process.env.FRESHSALES_API_KEY}`, 
    'Content-Type': 'application/json' 
};

const isFreshsalesReady = process.env.FRESHSALES_API_KEY && process.env.FRESHSALES_API_KEY !== 'TEMPORARY_TEST';

// --- AUTOMATION ENGINE: 5-HOUR TIMER CRON WORKER ---
cron.schedule('*/15 * * * *', async () => {
    console.log('Running 5-hour visitor tracking routine...');
    try {
        const staleVisits = await dbPool.query(`
            SELECT v.id AS visit_id, vis.freshsales_contact_id, vis.mobile_number 
            FROM visits v
            JOIN visitors vis ON v.visitor_id = vis.id
            WHERE v.visit_status = 'Checked In'
              AND v.whatsapp_triggered = FALSE
              AND v.check_in_time <= NOW() - INTERVAL '5 hours'
        `);

        for (const visit of staleVisits.rows) {
            if (isFreshsalesReady) {
                await axios.put(`${FRESHSALES_URL}/${visit.freshsales_contact_id}`, {
                    contact: {
                        custom_field: {
                            cf_trigger_whatsapp_feedback: "Trigger Now",
                            cf_visit_status: "Feedback Pending"
                        }
                    }
                }, { headers: FRESHSALES_HEADERS });
            } else {
                console.log(`[TEST MODE] 5 Hours hit for Visit ID ${visit.visit_id}. Skipping Freshsales WhatsApp trigger.`);
            }

            await dbPool.query(`
                UPDATE visits 
                SET whatsapp_triggered = TRUE, whatsapp_trigger_time = NOW(), visit_status = 'Feedback Pending'
                WHERE id = $1
            `, [visit.visit_id]);
        }
    } catch (err) {
        console.error('Error running automation loop:', err.message);
    }
});

function extractCardMetrics(rawText) {
    const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const emailRegex = /[\w.-]+@[\w.-]+\.\w+/;
    const phoneRegex = /(\+?\d{1,3}[- ]?)?\(?\d{3}\)?[- ]?\d{3}[- ]?\d{4}/;

    let email = lines.find(l => emailRegex.test(l)) || "";
    let mobile = lines.find(l => phoneRegex.test(l)) || "";
    let name = lines[0] || ""; 
    let company = lines[1] || "";

    return { name, company, email, mobile };
}

// --- API ENDPOINT 1: ALIVE/PING HEALTHCHECK (Prevents Spin-Down Delays) ---
app.get('/api/ping', (req, res) => {
    res.json({ status: "online", timezone: "Asia/Dubai", time: new Date().toISOString() });
});

// --- API ENDPOINT 2: BUSINESS CARD OCR PROCESSING ---
app.post('/api/scan-card', async (req, res) => {
    try {
        if (!visionClient) return res.status(500).json({ error: "Vision Client uninitialized." });
        const { imageBase64 } = req.body; 
        const buffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ""), 'base64');
        
        const [result] = await visionClient.documentTextDetection(buffer);
        const fullText = result.fullTextAnnotation ? result.fullTextAnnotation.text : "";
        
        if (!fullText) return res.status(400).json({ error: "No clear text detected on card." });
        
        const extractedData = extractCardMetrics(fullText);
        res.json(extractedData);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- API ENDPOINT 3: UNIFIED VISITOR CHECK-IN GATEWAY ---
app.post('/api/check-in', async (req, res) => {
    try {
        const { mobile, name, company, email, designation, nfcUrl, captureMethod, products } = req.body;

        if (!mobile) return res.status(400).json({ error: "Mobile number parameters are mandatory." });
        
        // Clean up safe fallbacks for missing name fields
        const safeName = (name && name.trim()) ? name.trim() : "Walk-in Visitor";
        const nameParts = safeName.split(/\s+/); // Splits cleanly on any spaces
        const firstName = nameParts[0] || safeName;
        const lastName = nameParts.slice(1).join(' ') || "Visitor";

        let visitor = await dbPool.query('SELECT * FROM visitors WHERE mobile_number = $1', [mobile]);
        let visitorId, freshsalesId;

        if (visitor.rows.length > 0) {
            visitorId = visitor.rows[0].id;
            freshsalesId = visitor.rows[0].freshsales_contact_id;
            
            // Dynamic sync: Instantly updates profile metrics if modified on touchscreen
            await dbPool.query(
                `UPDATE visitors SET full_name = $1, company_name = $2, email = $3, designation = $4, nfc_url = COALESCE(nfc_url, $5), interested_products = $6 WHERE id = $7`,
                [safeName, company, email, designation, nfcUrl, products, visitorId]
            );
        } else {
            const newVis = await dbPool.query(
                `INSERT INTO visitors (mobile_number, full_name, company_name, email, designation, nfc_url, interested_products) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
                [mobile, safeName, company, email, designation, nfcUrl, products]
            );
            visitorId = newVis.rows[0].id;

            if (isFreshsalesReady) {
                try {
                    const crmResponse = await axios.post(FRESHSALES_URL, {
                        contact: {
                            first_name: firstName,
                            last_name: lastName,
                            mobile_number: mobile,
                            emails: email || null,
                            job_title: designation || null,
                            custom_field: {
                                cf_lead_source: "Experience Center Kiosk",
                                cf_visit_status: "Checked In",
                                cf_visitor_capture_method: captureMethod,
                                cf_nfc_digital_card_url: nfcUrl || null,
                                cf_interested_products: products || []
                            }
                        }
                    }, { headers: FRESHSALES_HEADERS });
                    freshsalesId = crmResponse.data.contact.id;
                } catch(e) {
                    console.error("CRM push bypassed, falling back to local storage routing:", e.message);
                    freshsalesId = "CRM_FALLBACK_ID_" + Math.floor(Math.random() * 10000);
                }
            } else {
                freshsalesId = "TEST_MODE_ID_" + Math.floor(Math.random() * 10000);
            }
            await dbPool.query('UPDATE visitors SET freshsales_contact_id = $1 WHERE id = $2', [freshsalesId, visitorId]);
        }

        await dbPool.query(
            `INSERT INTO visits (visitor_id, capture_method, visit_status) VALUES ($1, $2, 'Checked In')`,
            [visitorId, captureMethod]
        );

        res.json({ success: true, message: "Check-in logged successfully.", freshsalesId });
    } catch (err) {
        console.error("Check-in processing error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- API ENDPOINT 4: VISITOR CHECK-OUT & FEEDBACK SUBMISSION ---
app.post('/api/check-out', async (req, res) => {
    try {
        const { lookupKey, score, comments, followUp } = req.body; 

        // FIXED LINE: Added the missing "BY" keyword to the SQL query below
        const activeSession = await dbPool.query(`
            SELECT v.id AS visit_id, vis.freshsales_contact_id FROM visits v
            JOIN visitors vis ON v.visitor_id = vis.id
            WHERE (vis.mobile_number = $1 OR vis.nfc_url = $1) AND v.visit_status IN ('Checked In', 'Feedback Pending')
            ORDER BY v.check_in_time DESC LIMIT 1
        `, [lookupKey]);

        if (activeSession.rows.length === 0) return res.status(404).json({ error: "No active check-in session located." });

        const { visit_id, freshsales_contact_id } = activeSession.rows[0];

        await dbPool.query(`UPDATE visits SET check_out_time = NOW(), visit_status = 'Completed' WHERE id = $1`, [visit_id]);
        await dbPool.query(`INSERT INTO feedback (visit_id, feedback_score, feedback_comments, follow_up_required) VALUES ($1, $2, $3, $4)`, [visit_id, score, comments, followUp]);

        if (isFreshsalesReady) {
            await axios.put(`${FRESHSALES_URL}/${freshsales_contact_id}`, {
                contact: {
                    custom_field: {
                        cf_visit_status: "Completed",
                        cf_feedback_score: score,
                        cf_feedback_comments: comments,
                        cf_follow_up_required: followUp
                    }
                }
            }, { headers: FRESHSALES_HEADERS });
        }

        res.json({ success: true, message: "Check-out feedback saved cleanly." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Brewmac Kiosk Server live on GST timezone port ${PORT}`));
