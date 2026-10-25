import fs from 'fs';

async function inspectWindow() {
  const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  const sub = targets.find(t => t.url && t.url.includes('answersheet'));
  console.log('Open sub-windows:', sub ? sub.url : 'None');
}

inspectWindow();
