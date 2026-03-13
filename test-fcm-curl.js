#!/usr/bin/env node
/**
 * Тест FCM: получает OAuth token из firebase.json и отправляет push через FCM API
 * Запуск: npm run test-fcm   или   node test-fcm-curl.js
 *
 * Нужен файл firebase.json с ключом сервисного аккаунта (Service Account JSON).
 * Опционально: FCM_TOKEN=... для своего токена устройства.
 */

import fs from 'fs';
import { JWT } from 'google-auth-library';

function getAccessToken(serviceAccount) {
  const jwtClient = new JWT({
    email: serviceAccount.client_email,
    key: serviceAccount.private_key,
    scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
  });
  return new Promise((resolve, reject) => {
    jwtClient.authorize((err, tokens) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(tokens.access_token);
    });
  });
}

async function main() {
  const sa = JSON.parse(fs.readFileSync('firebase.json', 'utf8'));
  const projectId = sa.project_id;
  const fcmToken =
    process.env.FCM_TOKEN ||
    'fRjS3gMclE5xqEgJsbstCg:APA91bGXTrXeLrb2dSMnytQR5vLqACLRI5x0sIFIB8IzirOcaZrxgr7vRcCNvMIBCs8dUq6hI5FkNnrrGhjHdzfN7yWYZaoKSPPyNx-Kll1R83BnmeiFZ4Q';

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
      Authorization: `Bearer ${token}`,
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
