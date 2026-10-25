import fs from 'fs';

async function run() {
  const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  const mainTarget = targets.find(t => !t.url.includes('answersheet') && t.webSocketDebuggerUrl);
  if (!mainTarget) {
    console.log('No main target');
    return;
  }

  const ws = new WebSocket(mainTarget.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);

  function cdpSend(method, params) {
    return new Promise((resolve, reject) => {
      const id = Math.floor(Math.random() * 1000000);
      const handler = (m) => {
        const data = JSON.parse(m.data);
        if (data.id === id) {
          ws.removeEventListener('message', handler);
          resolve(data.result);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  const res = await cdpSend('Runtime.evaluate', {
    expression: `(() => {
      const cards = Array.from(document.querySelectorAll('.baseTodoItem__D5dSs, .hoverItem__ARHDY'));
      return cards.map(c => {
        const title = (c.querySelector('.text__Y7dUq.ellipsis__cZ4V6, .title__N9_tN, h3, h4')?.innerText || '').trim();
        const btn = (c.querySelector('.button__EXmcJ')?.innerText || '').trim();
        const fullText = (c.innerText || '').trim();
        return { title, btn, fullText };
      });
    })()`,
    returnByValue: true
  });

  const lobbyCards = res?.result?.value || [];
  console.log(`=== CLASSIN LOBBY CARDS IN DOM (${lobbyCards.length}) ===`);
  lobbyCards.forEach((c, idx) => {
    console.log(`${idx + 1}. [${c.btn}] "${c.title}"`);
  });

  // Check database.json
  const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
  console.log(`\n=== DATABASE TODOS (${db.todos.length}) ===`);
  const missingFromLobby = [];
  for (const t of db.todos) {
    const found = lobbyCards.find(c => c.title.toLowerCase() === t.title.toLowerCase());
    if (!found) {
      missingFromLobby.push({ id: t.id, title: t.title, courseId: t.courseId });
    }
  }
  console.log(`Missing from active lobby: ${missingFromLobby.length}`);
  console.log(missingFromLobby);

  ws.close();
}

run();
