const express = require('express');
const app = express();

app.use(express.json());

app.post('/helius', (req, res) => {
    try {
        const webhook = req.body;
        
        // Process each transaction in the webhook
        if (webhook && Array.isArray(webhook)) {
            webhook.forEach(tx => {
                // Check account data for native balance changes
                if (tx.accountData && Array.isArray(tx.accountData)) {
                    tx.accountData.forEach(account => {
                        // Buy = nativeBalanceChange is negative (money going out)
                        if (account.nativeBalanceChange && account.nativeBalanceChange < 0) {
                            const wallet = account.account || account.userAccount || 'Unknown';
                            const solAmount = Math.abs(account.nativeBalanceChange) / 1_000_000_000;
                            
                            console.log('BUY:');
                            console.log(`Wallet: ${wallet}`);
                            console.log(`SOL: ${solAmount}`);
                        }
                    });
                }
            });
        }
        
        res.status(200).send('OK');
    } catch (error) {
        console.error('Error processing webhook:', error.message);
        res.status(200).send('OK');
    }
});

app.listen(3000, () => {
    console.log('Server listening on port 3000');
});


