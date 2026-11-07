# ♠ Poker Chip Counter

Contatore di chip per le partite di poker tra amici, **multigiocatore**: ognuno usa il proprio telefono e tutti vedono puntate, piatto e stack aggiornati in tempo reale.

## Come si gioca

1. **Crea partita** – chi organizza imposta colori e valori delle chip, quante chip riceve ognuno e i nomi dei giocatori. Riceve un **codice** (es. `K7QX`).
2. **Invita** – condividi il link (pulsante 📤) oppure gli altri aprono il sito e inseriscono il codice.
3. **Chi sei?** – ogni telefono sceglie il proprio nome (o si aggiunge). C'è anche la modalità **Banco**, che controlla tutti i giocatori, utile se qualcuno è senza telefono.
4. **Ogni mano** – tocca le chip per puntare, oppure *Vedo* / *All-in* / *Passa*. Il piatto si aggiorna su tutti i telefoni.
5. **Fine mano** – chiunque segna il vincitore (🏆) e preme *Assegna il piatto*. Con più vincitori il piatto viene diviso.
6. **Classifica e storico** – stack e guadagno/perdita di ciascuno, più l'elenco delle mani giocate. *Annulla* corregge l'ultima azione, *Ricarica* aggiunge uno stack.

Le partite restano salvate sul server e vengono cancellate dopo 7 giorni senza attività.

## Struttura

- `public/index.html` – l'app (una sola pagina)
- `src/worker.js` – Cloudflare Worker + Durable Object `Room`: una stanza per codice partita, sincronizzata via WebSocket
- `wrangler.jsonc` – configurazione Cloudflare

## Sviluppo e deploy

```bash
npm install
npm run dev      # http://localhost:8787
npm run deploy   # pubblica su Cloudflare Workers
```

Il repository è collegato a Cloudflare: ogni push su `main` viene pubblicato automaticamente.
