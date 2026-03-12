#!/usr/bin/env node
/**
 * Тест FCM: получает OAuth token из firebase.json и отправляет push через curl
 * Запуск: node test-fcm-curl.js
 */

const fs = require('fs');
const crypto = require('crypto');

function base64url(data) {
    const base64 = Buffer.from(data).toString('base64');
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken(serviceAccount) {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(JSON.stringify({
        iss: serviceAccount.client_email,
        sub: serviceAccount.client_email,
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
        scope: 'https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/cloud-platform',
    }));

    const signingInput = `${header}.${payload}`;
    const pemBody = serviceAccount.private_key
        .replace(/\\n/g, '\n')
        .replace(/-----BEGIN PRIVATE KEY-----/g, '')
        .replace(/-----END PRIVATE KEY-----/g, '')
        .replace(/\s/g, '');

    const sign = crypto.createSign('RSA-SHA256');
    sign.update(signingInput);
    const signature = sign.sign({
        key: serviceAccount.private_key.replace(/\\n/g, '\n'),
        format: 'pem',
    }, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const jwt = `${signingInput}.${signature}`;

    const resp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    });

    const data = await resp.json();
    if (!data.access_token) {
        throw new Error('FCM auth failed: ' + JSON.stringify(data));
    }
    return data.access_token;
}

async function main() {
    const sa = JSON.parse(fs.readFileSync('firebase.json', 'utf8'));
    const projectId = sa.project_id;
    const fcmToken = process.env.FCM_TOKEN || 'fRjS3gMclE5xqEgJsbstCg:APA91bGXTrXeLrb2dSMnytQR5vLqACLRI5x0sIFIB8IzirOcaZrxgr7vRcCNvMIBCs8dUq6hI5FkNnrrGhjHdzfN7yWYZaoKSPPyNx-Kll1R83BnmeiFZ4Q';

    console.log('Getting OAuth token...');
    const token = await getAccessToken(sa);
    console.log('Token received, length:', token.length);

    const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
    const body = JSON.stringify({
        message: {
            token: fcmToken,
            notification: { title: 'Test from curl', body: 'Hello from test script' },
            apns: { payload: { aps: { sound: 'default' } } },
        },
    });

    console.log('\n--- CURL command (for manual run) ---\n');
    console.log(`curl -X POST "${url}" \\`);
    console.log(`  -H "Authorization: Bearer ${token.slice(0, 50)}..." \\`);
    console.log(`  -H "Content-Type: application/json" \\`);
    console.log(`  -d '${body}'`);
    console.log('\n--- Executing request ---\n');

    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body,
    });

    const text = await resp.text();
    console.log('Status:', resp.status, resp.statusText);
    console.log('Response:', text);

    if (resp.ok) {
        console.log('\n✅ Success! Push sent.');
    } else {
        console.log('\n❌ Failed. Check Firebase/APNS config.');
    }
}

main().catch((e) => {
    console.error('Error:', e.message);
    process.exit(1);
});
