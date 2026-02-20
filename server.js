const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);

// Tracked token mint address
const TRACKED_TOKEN_MINT = process.env.TRACKED_MINT || "HACLKPh6WQ79gP9NuufSs9VkDUjVsk5wCdbBCjTLpump";

// Global in-memory state
const state = {
    lastWebhookAt: null,
    lastWebhookSig: null,
    lastParsedBuy: null,
    counters: {
        webhooksReceived: 0,
        txProcessed: 0,
        buysBroadcasted: 0,
        buysSkipped: 0,
        parseErrors: 0
    }
};

// Create WebSocket server on /ws path
const wss = new WebSocket.Server({ 
    server,
    path: '/ws'
});

// Store connected clients
const clients = new Set();

wss.on('connection', (ws) => {
    clients.add(ws);
    console.log(`ws connect: clients=${clients.size}`);
    
    ws.on('close', () => {
        clients.delete(ws);
        console.log(`ws disconnect: clients=${clients.size}`);
    });
    
    ws.on('error', (error) => {
        console.error('ws error:', error.message);
    });
});

app.use(express.json());

// Broadcast function
function broadcast(data) {
    const message = JSON.stringify(data);
    let sent = 0;
    clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
            sent++;
        }
    });
    return sent;
}

// GET /status endpoint
app.get('/status', (req, res) => {
    res.json({
        ok: true,
        trackedMint: TRACKED_TOKEN_MINT,
        counters: { ...state.counters },
        lastWebhookAt: state.lastWebhookAt,
        lastWebhookSig: state.lastWebhookSig,
        lastParsedBuy: state.lastParsedBuy,
        wsClients: clients.size
    });
});

// POST /helius webhook handler
app.post('/helius', (req, res) => {
    try {
        const webhook = req.body;
        
        // Increment webhook counter and update timestamp
        state.counters.webhooksReceived++;
        state.lastWebhookAt = new Date().toISOString();
        state.lastWebhookSig = webhook.signature || webhook[0]?.signature || null;
        
        // Handle both array and single object
        const transactions = Array.isArray(webhook) ? webhook : [webhook];
        
        let processed = 0;
        let buys = 0;
        let skipped = 0;
        
        // Process each transaction
        for (const tx of transactions) {
            // Skip if transaction has error
            if (tx.transactionError !== null && tx.transactionError !== undefined) {
                skipped++;
                continue;
            }
            
            state.counters.txProcessed++;
            processed++;
            
            // Detect BUY
            let buyer = null;
            let solSpent = 0;
            
            const transfers = tx.tokenTransfers || [];
            const nativeChanges = tx.nativeBalanceChanges || [];
            
            // Step a: Find buyer (who received tracked token)
            for (const t of transfers) {
                if (t.mint === TRACKED_TOKEN_MINT && 
                    Number(t.tokenAmount) > 0 && 
                    t.toUserAccount) {
                    buyer = t.toUserAccount;
                    break;
                }
            }
            
            // Step b: Find buyer's nativeBalanceChange
            if (buyer) {
                const change = nativeChanges.find(n => n.userAccount === buyer);
                
                if (!change) {
                    // Buyer found but no native balance change - skip
                    state.counters.buysSkipped++;
                    skipped++;
                    continue;
                }
                
                // Step c: BUY condition - must have spent SOL (negative change)
                if (change.nativeBalanceChange < 0) {
                    // Step d: Calculate SOL spent
                    solSpent = Math.abs(change.nativeBalanceChange) / 1e9;
                    
                    if (solSpent > 0) {
                        // Create buy event
                        const buyEvent = {
                            type: "BUY",
                            wallet: buyer,
                            sol: solSpent,
                            signature: tx.signature || null,
                            timestamp: tx.timestamp || Date.now()
                        };
                        
                        // Broadcast to WebSocket clients
                        broadcast(buyEvent);
                        
                        // Update state
                        state.lastParsedBuy = {
                            wallet: buyer,
                            sol: solSpent,
                            sig: tx.signature || null,
                            ts: buyEvent.timestamp
                        };
                        
                        state.counters.buysBroadcasted++;
                        buys++;
                        
                        // Log buy
                        const walletShort = buyer.length >= 4 ? buyer.slice(-4) : buyer;
                        console.log(`BUY wallet=${walletShort} sol=${solSpent.toFixed(4)} sig=${tx.signature || 'N/A'}`);
                    } else {
                        state.counters.buysSkipped++;
                        skipped++;
                    }
                } else {
                    // Positive or zero balance change - not a buy (could be sell or transfer)
                    state.counters.buysSkipped++;
                    skipped++;
                }
            } else {
                // No buyer found - not a buy for our token
                skipped++;
            }
        }
        
        // Log webhook summary
        console.log(`webhook ok: txCount=${transactions.length} processed=${processed} buys=${buys} skipped=${skipped}`);
        
        res.status(200).send('OK');
    } catch (error) {
        state.counters.parseErrors++;
        console.error(`parse error: ${error.message}`);
        res.status(200).send('OK');
    }
});

server.listen(3000, () => {
    console.log('Server listening on port 3000');
    console.log('WebSocket server ready on /ws');
    console.log('Status endpoint: GET /status');
});
