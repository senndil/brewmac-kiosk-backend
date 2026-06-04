const express = require('express');
const { Pool } = require('pg');
const vision = require('@google-cloud/vision');
const axios = require('axios');
const cron = require('node-cron');
const cors = require('cors');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());

// --- CONFIGURATION MANAGEMENT ---
const dbPool = new Pool({ connectionString: process.env.DATABASE_URL });

// Fixed line for Render text-based credentials loading
const visionClient = new vision.ImageAnnotatorClient({ 
    credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS) 
});

const FRESHSALES_URL = `https://${process.env.FRESHSALES_DOMAIN}.freshsales.io/api/contacts`;
const FRESHSALES_HEADERS = { 
    'Authorization': `Token token=${process.env.FRESHSALES_API_KEY}`, 
    'Content-Type': 'application/json' 
};

// Check if Freshsales is ready or if we are in Test Mode
const isFreshsalesReady = process.env.FRESHSALES_API_KEY && process.env.FRESHSALES_API_KEY !== 'TEMPORARY_TEST';

// --- AUTOMATION ENGINE: 5-HOUR TIMER CRON WORKER ---
cron.schedule('*/15 * * * *', async () => {
    console.log('Running 5-hour visitor tracking routine...');
    try {
        const staleVisits = await dbPool.query(`
            SELECT v.id AS visit_id, vis.freshsales_contact_id 
            FROM visits v
            JOIN visitors vis ON v.visitor_id = vis.id
            WHERE v.visit_status = 'Checked In'
              AND v.whatsapp_triggered = FALSE
              AND v.check_in_time <= NOW() - INTERVAL '5 hours'
        `);

        for (const visit of staleVisits.rows) {
            if (isFreshsalesReady) {
                // Send trigger flag directly to Freshsales via API patch
                await axios.put(`${FRESHSALES_URL}/${visit.freshsales_contact_id}`, {
                    contact: {
                        custom_field: {
                            cf_trigger_whatsapp_feedback: "Trigger Now",
                            cf_visit_status: "Feedback Pending"
                        }
                    }
                }, { headers: FRESHSALES_HEADERS });
            } else {
                console.log(`[TEST MODE] 5 Hours exceeded for Visit ID ${visit.visit_id}. Skipping Freshsales WhatsApp trigger.`);
            }

            // Mark locally so we never double-send the alert
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

// --- HELPER STRATEGIES: REGEX EXTRACTOR FOR OCR ---
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

// --- API ENDPOINT 1: BUSINESS CARD OCR PROCESSING ---
app.post('/api/scan-card', async (req, res) => {
    try {
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

// --- API ENDPOINT 2: UNIFIED VISITOR CHECK-IN GATEWAY ---
app.post('/api/check-in', async (req, res) => {
    try {
        const { mobile, name, company, email, designation, nfcUrl, captureMethod, products } = req.body;

        // Step A: Local Cache Deduplication Verification
        let visitor = await dbPool.query('SELECT * FROM visitors WHERE mobile_number = $1', [mobile]);
        let visitorId, freshsalesId;

        if (visitor.rows.length > 0) {
            visitorId = visitor.rows[0].id;
            freshsalesId = visitor.rows[0].freshsales_contact_id;
        } else {
            // Step B: If completely new visitor, insert locally first
            const newVis = await dbPool.query(
                `INSERT INTO visitors (mobile_number, full_name, company_name, email, designation, nfc_url) 
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
                [mobile, name, company, email, designation, nfcUrl]
            );
            visitorId = newVis.rows[0].id;

            if (isFreshsalesReady) {
                // Step C: Push real-time to Freshsales CRM
                const crmResponse = await axios.post(FRESHSALES_URL, {
                    contact: {
                        first_name: name.split(' ')[0] || name,
                        last_name: name.split(' ').slice(1).join(' ') || "Visitor",
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
                await dbPool.query('UPDATE visitors SET freshsales_contact_id = $1 WHERE id = $2', [freshsalesId, visitorId]);
            } else {
                freshsalesId = "TEST_MODE_ID_" + Math.floor(Math.random() * 10000);
                await dbPool.query('UPDATE visitors SET freshsales_contact_id = $1 WHERE id = $2', [freshsalesId, visitorId]);
                console.log(`[TEST MODE] Saved visitor locally. Generated fake Freshsales ID: ${freshsalesId}`);
            }
        }

        // Step D: Open an active session in the local visits log table
        await dbPool.query(
            `INSERT INTO visits (visitor_id, capture_method, visit_status) VALUES ($1, $2, 'Checked In')`,
            [visitorId, captureMethod]
        );

        res.json({ success: true, message: "Check-in logged locally.", freshsalesId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- API ENDPOINT 3: VISITOR CHECK-OUT & FEEDBACK SUBMISSION ---
app.post('/api/check-out', async (req, res) => {
    try {
        const { lookupKey, score, comments, followUp } = req.body; 

        // Find active visit session
        const activeSession = await dbPool.query(`
            SELECT v.id AS visit_id, vis.freshsales_contact_id FROM visits v
            JOIN visitors vis ON v.visitor_id = vis.id
            WHERE (vis.mobile_number = $1 OR vis.nfc_url = $1) AND v.visit_status IN ('Checked In', 'Feedback Pending')
            ORDER BY v.check_in_time DESC LIMIT 1
        `, [lookupKey]);

        if (activeSession.rows.length === 0) return res.status(404).json({ error: "No active check-in session found." });

        const { visit_id, freshsales_contact_id } = activeSession.rows[0];

        // Update database entries locally
        await dbPool.query(`UPDATE visits SET check_out_time = NOW(), visit_status = 'Completed' WHERE id = $1`, [visit_id]);
        await dbPool.query(`INSERT INTO feedback (visit_id, feedback_score, feedback_comments, follow_up_required) VALUES ($1, $2, $3, $4)`, [visit_id, score, comments, followUp]);

        if (isFreshsalesReady) {
            // Push immediate close-out details to CRM
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
        } else {
            console.log(`[TEST MODE] Checkout complete for fake Freshsales ID: ${freshsales_contact_id}. Data saved locally.`);
        }

        res.json({ success: true, message: "Check-out processed locally." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(3000, () => console.log('Brewmac Kiosk Core Server running online on port 3000.'));
