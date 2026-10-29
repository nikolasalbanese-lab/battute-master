/* Battute master: collegamento diretto a Google (Doc e Drive) e all'IA di Claude.
   Gira nel browser, senza server. Le impostazioni personali stanno in config.js e sul telefono. */
(function () {
"use strict";
const CFG = Object.assign({clientId: "", docId: "1G-x44hzzeRuwVhSuyaEdNBlwxgDSolRn8a4JnHarNf4", model: "claude-sonnet-5-5"}, window.BM_CONFIG || {});
const SCOPES = ["https://www.googleapis.com/auth/documents", "https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/drive.appdata"].join(" ");
const API = {docs: "https://docs.googleapis.com/v1/documents/", drive: "https://www.googleapis.com/drive/v3/files", upload: "https://www.googleapis.com/upload/drive/v3/files"};
const LS = {
  get(k, d){ try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
  set(k, v){ try { localStorage.setItem(k, v); } catch (e) {} },
  del(k){ try { localStorage.removeItem(k); } catch (e) {} }
};
class AuthError extends Error {}

/* ---------- Accesso Google ---------- */
let token = LS.get("bm-g-token", ""), tokenExp = +LS.get("bm-g-exp", "0"), tokClient = null;
const signedIn = () => !!token && Date.now() < tokenExp;
function gsiReady(){
  return new Promise((res, rej) => {
    if (window.google && google.accounts && google.accounts.oauth2) return res();
    const s = document.createElement("script"); s.src = "https://accounts.google.com/gsi/client"; s.async = true;
    s.onload = () => res(); s.onerror = () => rej(new Error("Non riesco a caricare l'accesso Google: controlla la rete."));
    document.head.appendChild(s);
  });
}
async function signIn(){
  if (!CFG.clientId) throw new Error("Manca l'ID cliente Google in config.js.");
  await gsiReady();
  const resp = await new Promise((resolve, reject) => {
    tokClient = tokClient || google.accounts.oauth2.initTokenClient({client_id: CFG.clientId, scope: SCOPES, callback: () => {}, error_callback: () => {}});
    tokClient.callback = r => (r && r.access_token) ? resolve(r) : reject(new Error((r && r.error) || "Accesso negato."));
    tokClient.error_callback = e => reject(new Error((e && e.type) || "Accesso annullato."));
    tokClient.requestAccessToken({prompt: LS.get("bm-g-seen", "") ? "" : "consent"});
  });
  token = resp.access_token; tokenExp = Date.now() + ((+resp.expires_in || 3600) - 120) * 1000;
  LS.set("bm-g-token", token); LS.set("bm-g-exp", String(tokenExp)); LS.set("bm-g-seen", "1");
  return token;
}
function signOut(){
  try { if (token && window.google && google.accounts) google.accounts.oauth2.revoke(token, () => {}); } catch (e) {}
  token = ""; tokenExp = 0; LS.del("bm-g-token"); LS.del("bm-g-exp"); LS.del("bm-g-seen");
}
async function gfetch(url, opts){
  if (!signedIn()) throw new AuthError("Sessione Google scaduta: tocca Accedi.");
  const o = Object.assign({}, opts); o.headers = Object.assign({}, (opts && opts.headers) || {}, {Authorization: "Bearer " + token});
  const r = await fetch(url, o);
  if (r.status === 401){ token = ""; tokenExp = 0; throw new AuthError("Sessione Google scaduta: tocca Accedi."); }
  if (!r.ok){
    let t = ""; try { t = await r.text(); } catch (e) {}
    const err = new Error("Google ha risposto " + r.status + (t ? ": " + t.slice(0, 160) : "")); err.status = r.status; throw err;
  }
  return r;
}

/* ---------- Doc master -> testo, nello stesso formato letto dall'app ---------- */
function docBody(doc){
  const c = doc && doc.content && doc.content.tabs ? doc.content : doc;
  const tab = c && c.tabs && c.tabs[0];
  return {c, tab, body: tab ? tab.documentTab.body.content : ((c && c.body && c.body.content) || [])};
}
function docToMarkdown(doc){
  const out = [], {body} = docBody(doc);
  const runs = p => (p.elements || []).map(e => {
    const tr = e.textRun; if (!tr) return "";
    const t = (tr.content || "").replace(/\n/g, ""); if (!t) return "";
    const u = tr.textStyle && tr.textStyle.link && tr.textStyle.link.url;
    return u ? "[" + t + "](" + u + ")" : t;
  }).join("");
  for (const el of body){
    const p = el.paragraph; if (!p) continue;
    const st = (p.paragraphStyle && p.paragraphStyle.namedStyleType) || "NORMAL_TEXT", txt = runs(p);
    if (!txt.trim()) continue;
    if (st === "HEADING_1") out.push("# **" + txt + "**", "");
    else if (st === "HEADING_2") out.push("", "## **" + txt + "**", "");
    else if (p.bullet) out.push("  - " + txt);
    else out.push(txt, "");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/* ---------- Inserire battute nel Doc, nella sezione giusta, con il formato delle altre ---------- */
function paragraphText(p){ return (p.elements || []).map(e => e.textRun ? e.textRun.content : "").join("").replace(/\n$/, ""); }
function buildInsertRequests(doc, items){
  const {tab, body} = docBody(doc), tabId = tab && tab.tabProperties && tab.tabProperties.tabId;
  // ultima riga puntata di ogni sezione
  const last = {}; let cur = null;
  for (const el of body){
    const p = el.paragraph; if (!p) continue;
    const st = (p.paragraphStyle && p.paragraphStyle.namedStyleType) || "NORMAL_TEXT";
    if (st === "HEADING_2"){ cur = paragraphText(p).trim(); last[cur] = null; }
    else if (st === "HEADING_1"){ cur = null; }
    else if (p.bullet && cur) last[cur] = el;
  }
  const norm = s => String(s || "").trim().toLowerCase();
  const byNorm = {}; Object.keys(last).forEach(k => { byNorm[norm(k)] = k; });
  const groups = new Map();
  for (const it of items){
    const k = byNorm[norm(it.sezione)];
    if (!k) throw new Error("Sezione non trovata nel Doc: " + (it.sezione || "(vuota)"));
    if (!last[k]) throw new Error("La sezione «" + k + "» non ha ancora battute da cui copiare il formato.");
    if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it);
  }
  const lineStyle = {underline: true, foregroundColor: {color: {rgbColor: {blue: 0.93333334}}}};
  const reqs = [];
  const ordered = [...groups.entries()].map(([k, list]) => ({idx: last[k].endIndex - 1, list})).sort((a, b) => b.idx - a.idx);
  for (const g of ordered){
    let S = "", pos = g.idx; const links = [];
    for (const it of g.list){
      const text = String(it.testo).replace(/\s*\n\s*/g, " ").trim();
      const src = it.fonte ? " \u2014 " + it.fonte : "";
      const start = pos + 1 + text.length + (it.fonte ? 3 : 0);
      const chunk = "\n" + text + src;
      if (it.fonte && it.url) links.push({s: start, e: start + it.fonte.length, url: it.url});
      S += chunk; pos += chunk.length;
    }
    const range = (s, e) => Object.assign({startIndex: s, endIndex: e}, tabId ? {tabId} : {});
    reqs.push({insertText: Object.assign({location: Object.assign({index: g.idx}, tabId ? {tabId} : {}), text: S})});
    reqs.push({updateTextStyle: {range: range(g.idx, g.idx + S.length), textStyle: {}, fields: "link,underline,foregroundColor"}});
    for (const l of links) reqs.push({updateTextStyle: {range: range(l.s, l.e), textStyle: Object.assign({link: {url: l.url}}, lineStyle), fields: "link,underline,foregroundColor"}});
  }
  return reqs;
}

/* ---------- Togliere battute dal Doc ---------- */
const keyOf = t => String(t || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
function planRemoval(doc, keys){
  const found = new Set(), ranges = [];
  const c = doc && doc.content && doc.content.tabs ? doc.content : doc;
  for (const tab of (c.tabs || [])){
    const body = tab.documentTab && tab.documentTab.body && tab.documentTab.body.content; if (!body || !body.length) continue;
    const lastEnd = body[body.length - 1].endIndex, tabId = tab.tabProperties && tab.tabProperties.tabId;
    for (const el of body){
      const par = el.paragraph; if (!par || !par.bullet) continue;
      const left = paragraphText(par), i = left.lastIndexOf(" \u2014 "), head = keyOf(i > 0 ? left.slice(0, i) : left), all = keyOf(left);
      const hit = keys.find(k => head === k || all.startsWith(k + " "));
      if (!hit) continue;
      found.add(hit);
      const isLast = el.endIndex === lastEnd, range = isLast ? {startIndex: el.startIndex - 1, endIndex: el.endIndex - 1} : {startIndex: el.startIndex, endIndex: el.endIndex};
      if (tabId) range.tabId = tabId;
      ranges.push(range);
    }
  }
  ranges.sort((a, b) => b.startIndex - a.startIndex);
  return {ranges, found};
}

/* ---------- Leggere i file sorgente (Doc, Word, PDF, testo) ---------- */
async function inflateRaw(u8){
  const ds = new DecompressionStream("deflate-raw"), w = ds.writable.getWriter(); w.write(u8); w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}
async function unzipEntry(buf, wanted){
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let e = u8.length - 22; while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error("File Word non valido");
  let off = dv.getUint32(e + 16, true); const n = dv.getUint16(e + 10, true);
  for (let i = 0; i < n; i++){
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true), csize = dv.getUint32(off + 20, true), nl = dv.getUint16(off + 28, true), el = dv.getUint16(off + 30, true), cl = dv.getUint16(off + 32, true), lho = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(u8.subarray(off + 46, off + 46 + nl));
    if (name === wanted){
      const lnl = dv.getUint16(lho + 26, true), lel = dv.getUint16(lho + 28, true), start = lho + 30 + lnl + lel, raw = u8.subarray(start, start + csize);
      return method === 0 ? raw : inflateRaw(raw);
    }
    off += 46 + nl + el + cl;
  }
  throw new Error("Nel file Word non c'è il testo");
}
const xmlDecode = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
async function docxText(buf){
  const xml = new TextDecoder().decode(await unzipEntry(buf, "word/document.xml"));
  return xml.split("</w:p>").map(par => {
    const t = par.replace(/<w:tab\/>/g, "<w:t>\t</w:t>").replace(/<w:br[^>]*\/>/g, "<w:t>\n</w:t>");
    const parts = []; const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g; let m;
    while ((m = re.exec(t))) parts.push(xmlDecode(m[1]));
    return parts.join("");
  }).filter(l => l.trim()).join("\n");
}
function b64(buf){
  const u8 = new Uint8Array(buf); let s = ""; const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}
const fileIdOf = url => { const m = /\/d\/([^/?#]+)/.exec(url || "") || /[?&]id=([^&]+)/.exec(url || ""); return m ? m[1] : ""; };
async function sourceContent(id){
  const m = await (await gfetch(API.drive + "/" + id + "?fields=id,name,mimeType&supportsAllDrives=true")).json(), mt = m.mimeType || "";
  if (mt === "application/vnd.google-apps.document")
    return {name: m.name, text: await (await gfetch(API.drive + "/" + id + "/export?mimeType=text%2Fplain")).text()};
  if (mt === "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    return {name: m.name, text: await docxText(await (await gfetch(API.drive + "/" + id + "?alt=media&supportsAllDrives=true")).arrayBuffer())};
  if (mt === "application/pdf")
    return {name: m.name, pdf: b64(await (await gfetch(API.drive + "/" + id + "?alt=media&supportsAllDrives=true")).arrayBuffer())};
  if (mt.indexOf("text/") === 0)
    return {name: m.name, text: await (await gfetch(API.drive + "/" + id + "?alt=media&supportsAllDrives=true")).text()};
  return {name: m.name, skip: "formato non supportato (" + mt + ")"};
}

/* ---------- Chiamata all'IA ---------- */
const SYSTEM = [
  "Sei l'assistente di Nikolas Albanese, mago e comico italiano. Il suo \"master\" è una raccolta di battute divise in sezioni.",
  "Il tuo compito: leggere il contenuto di UN file sorgente e proporre le battute NUOVE che meritano di entrare nel master.",
  "Cosa conta come battuta: una frase o un breve giro comico (attacco e chiusa) che si capisce da solo e si può dire dal vivo. Riporta il testo come sta nel file, senza riscriverlo; puoi togliere solo indicazioni di scena tra parentesi se non servono.",
  "Cosa NON è una battuta: pezzi di routine con più passaggi, dialoghi col pubblico che non si capiscono da soli, indicazioni di scena, descrizioni di giochi, titoli, appunti organizzativi. Mettili in \"escluse\" con un motivo breve.",
  "Non riproporre nulla che sia già nell'elenco GIÀ NEL MASTER O GIÀ DECISE, nemmeno con piccole variazioni di parole.",
  "Assegna a ogni battuta UNA sezione, scelta esattamente tra quelle indicate. Aggiungi \"note\" (breve, può essere vuota) con commenti dell'autore presenti nel file, somiglianze con battute già presenti o dubbi sulla logica.",
  "Rispondi SOLO con JSON valido, senza altro testo: {\"battute\":[{\"testo\":\"\",\"sezione\":\"\",\"note\":\"\"}],\"escluse\":[{\"testo\":\"\",\"motivo\":\"\"}]}"
].join("\n");
function buildSearchContent(src, sections, known){
  const head = "FILE: " + src.name + "\n\nSEZIONI (usa esattamente queste):\n" + sections.map(s => "- " + s).join("\n") +
    "\n\nGIÀ NEL MASTER O GIÀ DECISE:\n" + (known.length ? known.map(t => "- " + t).join("\n") : "(nessuna)");
  if (src.pdf) return [{type: "document", source: {type: "base64", media_type: "application/pdf", data: src.pdf}}, {type: "text", text: head + "\n\nIl contenuto del file è nel PDF allegato."}];
  return head + "\n\nTESTO DEL FILE:\n" + src.text;
}
function parseAiJson(text){
  let t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("La risposta dell'IA non contiene dati leggibili.");
  const j = JSON.parse(t.slice(a, b + 1));
  const arr = x => Array.isArray(x) ? x : [];
  return {
    battute: arr(j.battute).filter(x => x && typeof x.testo === "string" && x.testo.trim()).map(x => ({testo: x.testo.trim(), sezione: String(x.sezione || "").trim(), note: String(x.note || "").trim()})),
    escluse: arr(j.escluse).filter(x => x && typeof x.testo === "string" && x.testo.trim()).map(x => ({testo: x.testo.trim(), motivo: String(x.motivo || "").trim()}))
  };
}
async function callClaude(content, key, model){
  let r;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {"content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true"},
      body: JSON.stringify({model, max_tokens: 8000, system: SYSTEM, messages: [{role: "user", content}]})
    });
  } catch (e) { throw new Error("Non riesco a raggiungere l'IA: controlla la rete."); }
  if (!r.ok){
    let msg = ""; try { const j = await r.json(); msg = j.error && j.error.message ? j.error.message : ""; } catch (e) {}
    if (r.status === 401) throw new Error("Chiave API non valida: controlla le impostazioni.");
    if (r.status === 429) throw new Error("Troppe richieste all'IA: riprova tra poco.");
    throw new Error("L'IA ha risposto " + r.status + (msg ? ": " + msg.slice(0, 140) : ""));
  }
  const j = await r.json();
  return (j.content || []).filter(b => b.type === "text").map(b => b.text).join("");
}

/* ---------- Memoria condivisa (commenti, registrate, valutazioni) ---------- */
const COLS = ["battute", "aggiunte", "rimozioni", "richieste", "registrate", "commenti"];
let st = (() => { try { const j = JSON.parse(LS.get("bm-store", "{}")); return {d: j.d || {}, u: j.u || {}, x: j.x || {}}; } catch (e) { return {d: {}, u: {}, x: {}}; } })();
const subs = {};
function ens(n){ st.d[n] = st.d[n] || {}; st.u[n] = st.u[n] || {}; st.x[n] = st.x[n] || {}; }
let pushT = null;
function persist(){ LS.set("bm-store", JSON.stringify(st)); schedulePush(); }
function emit(n){ ens(n); const o = st.d[n], snap = {docs: Object.keys(o).map(id => ({id, data: () => o[id]}))}; (subs[n] || []).forEach(f => { try { f(snap); } catch (e) { console.error(e); } }); }
const later = n => setTimeout(() => emit(n), 0);
const uid = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
function touch(n, id){ ens(n); st.u[n][id] = Date.now(); delete st.x[n][id]; }
const db = {collection(n){
  ens(n);
  const col = {
    onSnapshot(cb){ (subs[n] = subs[n] || []).push(cb); setTimeout(() => emit(n), 0); return () => { subs[n] = (subs[n] || []).filter(f => f !== cb); }; },
    async add(data){ const id = uid(); st.d[n][id] = data; touch(n, id); persist(); later(n); return col.doc(id); },
    doc(id){ return {id,
      async get(){ return {id, exists: !!st.d[n][id], data: () => st.d[n][id]}; },
      async set(data){ st.d[n][id] = data; touch(n, id); persist(); later(n); },
      async update(patch){ st.d[n][id] = Object.assign({}, st.d[n][id] || {}, patch); touch(n, id); persist(); later(n); },
      async delete(){ delete st.d[n][id]; delete st.u[n][id]; st.x[n][id] = Date.now(); persist(); later(n); } }; }
  };
  return col;
}};
function mergeRemote(rem){
  let changed = false;
  const names = new Set([...Object.keys(rem.d || {}), ...Object.keys(rem.x || {}), ...Object.keys(st.d)]);
  for (const n of names){
    ens(n);
    const rd = (rem.d || {})[n] || {}, ru = (rem.u || {})[n] || {}, rx = (rem.x || {})[n] || {};
    const ids = new Set([...Object.keys(rd), ...Object.keys(rx), ...Object.keys(st.d[n]), ...Object.keys(st.x[n])]);
    for (const id of ids){
      const lt = Math.max(st.u[n][id] || 0, st.x[n][id] || 0), mu = ru[id] || 0, mx = rx[id] || 0;
      if (Math.max(mu, mx) <= lt) continue;
      if (mx > mu){ if (id in st.d[n]){ delete st.d[n][id]; changed = true; } st.x[n][id] = mx; delete st.u[n][id]; }
      else { st.d[n][id] = rd[id]; st.u[n][id] = mu; delete st.x[n][id]; changed = true; }
    }
  }
  return changed;
}
let stateId = LS.get("bm-g-stateid", "");
async function findState(){
  if (stateId) return stateId;
  const q = encodeURIComponent("name='battute-state.json'");
  const j = await (await gfetch(API.drive + "?spaces=appDataFolder&q=" + q + "&fields=files(id)&pageSize=1")).json();
  stateId = j.files && j.files[0] ? j.files[0].id : ""; if (stateId) LS.set("bm-g-stateid", stateId);
  return stateId;
}
async function pull(){
  const id = await findState(); if (!id) return;
  let rem; try { rem = await (await gfetch(API.drive + "/" + id + "?alt=media")).json(); }
  catch (e) { if (e.status === 404){ stateId = ""; LS.del("bm-g-stateid"); return; } throw e; }
  if (mergeRemote(rem)){ LS.set("bm-store", JSON.stringify(st)); COLS.forEach(emit); }
}
async function push(){
  const body = JSON.stringify(st);
  if (!(await findState())){
    const boundary = "bm" + uid(), meta = {name: "battute-state.json", parents: ["appDataFolder"], mimeType: "application/json"};
    const payload = "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify(meta) + "\r\n--" + boundary + "\r\nContent-Type: application/json\r\n\r\n" + body + "\r\n--" + boundary + "--";
    const j = await (await gfetch(API.upload + "?uploadType=multipart&fields=id", {method: "POST", headers: {"Content-Type": "multipart/related; boundary=" + boundary}, body: payload})).json();
    stateId = j.id; LS.set("bm-g-stateid", stateId);
  } else {
    try { await gfetch(API.upload + "/" + stateId + "?uploadType=media", {method: "PATCH", headers: {"Content-Type": "application/json"}, body}); }
    catch (e) { if (e.status === 404){ stateId = ""; LS.del("bm-g-stateid"); return push(); } throw e; }
  }
}
function schedulePush(){ if (!signedIn()) return; clearTimeout(pushT); pushT = setTimeout(() => { push().catch(e => console.warn("sync", e)); }, 1500); }

/* La pagina cerca window.claude: qui c'è solo la memoria locale + Drive */
window.claude = {use: async name => name === "db" ? db : null};

/* ---------- Parte che parte dopo il caricamento dell'interfaccia ---------- */
function init(){
  const $ = id => document.getElementById(id);
  const hhmm = () => new Date().toLocaleTimeString("it-IT", {hour: "2-digit", minute: "2-digit"});
  const errText = e => (e && e.message) ? e.message : "errore sconosciuto";

  // copia salvata del master, mostrata subito
  const cached = LS.get("bm-master", "");
  if (cached){ try { const p = parse(cached); if (p.sections.length){ data = p; renderAll(); } } catch (e) {} }

  async function loadMaster(){
    setStatus("Carico il Google Doc…");
    const doc = await (await gfetch(API.docs + CFG.docId + "?includeTabsContent=true")).json();
    const md = docToMarkdown(doc), parsed = parse(md);
    if (!parsed.sections.length) throw new Error("Nel Doc non trovo sezioni riconoscibili.");
    data = parsed; LS.set("bm-master", md); renderAll();
    setStatus("Aggiornato dal Google Doc alle " + hhmm(), true);
    return doc;
  }
  window.refreshDoc = () => loadMaster().catch(showErr);
  function showErr(e){
    if (e instanceof AuthError) setStatus("Copia salvata · sessione Google scaduta", false, "Accedi");
    else setStatus("Copia salvata · " + errText(e).slice(0, 90), false, "Riprova");
  }
  async function connect(interactive){
    try {
      if (interactive) await signIn();
      if (!signedIn()){ setStatus(CFG.clientId ? "Accedi con Google per collegare il Doc e il Drive" : "Manca l'ID cliente Google in config.js", false, CFG.clientId ? "Accedi" : ""); updGState(); return false; }
      updGState();
      await Promise.all([loadMaster().catch(showErr), pull().then(() => schedulePush()).catch(e => console.warn("sync", e))]);
      return true;
    } catch (e) { showErr(e); updGState(); return false; }
  }
  $("status").addEventListener("click", e => { if (e.target.id === "statusBtn") connect(true); });

  // ----- Togliere battute dal Doc -----
  window.removeFromDoc = async function (items){
    const keys = items.map(x => x.key);
    rmBusy = true; updRmBanner();
    try {
      if (!signedIn()) throw new AuthError("Accedi con Google per modificare il Doc.");
      let plan = null, done = false;
      for (let attempt = 0; attempt < 2 && !done; attempt++){
        const doc = await (await gfetch(API.docs + CFG.docId + "?includeTabsContent=true")).json();
        plan = planRemoval(doc, keys);
        if (!plan.ranges.length){ done = true; break; }
        try {
          await gfetch(API.docs + CFG.docId + ":batchUpdate", {method: "POST", headers: {"Content-Type": "application/json"},
            body: JSON.stringify({requests: plan.ranges.map(r => ({deleteContentRange: {range: r}})), writeControl: {requiredRevisionId: doc.revisionId}})});
          done = true;
        } catch (e) { if (e.status === 400 && attempt === 0) continue; throw e; }
      }
      const now = new Date().toISOString(), missing = [];
      for (const it of items){
        if (plan.found.has(it.key)) await it.ref.update({applicata: true, applicataIl: now, esito: "tolta dal Doc"}); else missing.push(it);
      }
      loadMaster().catch(showErr);
      if (missing.length) toast(missing.length === 1 ? "1 battuta non l'ho trovata nel Doc." : missing.length + " battute non le ho trovate nel Doc.");
      else toast(items.length === 1 ? "Tolta dal Google Doc" : items.length + " battute tolte dal Google Doc");
    } catch (e) {
      toast(e instanceof AuthError ? "Accedi con Google per modificare il Doc." : "Rimozione non riuscita: " + errText(e).slice(0, 80));
    } finally { rmBusy = false; updRmBanner(); }
  };

  // ----- Portare le decisioni nel Doc -----
  window.fireApply = async function (){
    try {
      if (!signedIn()) throw new AuthError("Accedi con Google per modificare il Doc.");
      ens("battute"); ens("aggiunte");
      const B = Object.entries(st.d.battute).map(([id, r]) => Object.assign({id}, r));
      const A = Object.entries(st.d.aggiunte).map(([id, r]) => Object.assign({id}, r));
      const keep = B.filter(r => r.stato === "tieni" && !r.applicata);
      const drop = B.filter(r => (r.stato === "scarta" || r.stato === "esclusa") && !r.applicata);
      const adds = A.filter(r => !r.applicata && typeof r.testo === "string" && r.testo.trim());
      const todo = keep.map(r => ({testo: (r.testoFinale || r.testo || "").trim(), sezione: r.sezioneFinale || r.sezione, fonte: r.fonte, url: r.fonteUrl}))
        .concat(adds.map(r => ({testo: r.testo.trim(), sezione: r.sezione || r.sezioneFinale || "", fonte: "Aggiunta da Nikolas", url: ""})));
      const now = new Date().toISOString();
      if (todo.length){
        for (let attempt = 0; attempt < 2; attempt++){
          const doc = await (await gfetch(API.docs + CFG.docId + "?includeTabsContent=true")).json();
          const requests = buildInsertRequests(doc, todo);
          try { await gfetch(API.docs + CFG.docId + ":batchUpdate", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({requests, writeControl: {requiredRevisionId: doc.revisionId}})}); break; }
          catch (e) { if (e.status === 400 && attempt === 0) continue; throw e; }
        }
      }
      for (const r of keep.concat(drop)) await db.collection("battute").doc(r.id).update({applicata: true, applicataIl: now});
      for (const r of adds) await db.collection("aggiunte").doc(r.id).update({applicata: true, applicataIl: now});
      loadMaster().catch(showErr);
      toast(todo.length ? (todo.length === 1 ? "1 battuta portata nel Google Doc" : todo.length + " battute portate nel Google Doc") : "Decisioni registrate");
      return true;
    } catch (e) {
      toast(e instanceof AuthError ? "Accedi con Google per modificare il Doc." : "Non sono riuscito a scrivere nel Doc: " + errText(e).slice(0, 80));
      return false;
    }
  };

  // ----- Ricerca di nuove battute con l'IA -----
  const known = () => {
    const out = [], seen = new Set();
    const add = t => { const k = keyOf(t); if (t && !seen.has(k)){ seen.add(k); out.push(String(t).replace(/\s+/g, " ").trim().slice(0, 170)); } };
    view.forEach(s => s.jokes.forEach(j => { if (!j.pending) add(j.text); }));
    qRows.forEach(r => { if (["tieni", "scarta", "rimanda", "esclusa"].indexOf(r.stato) >= 0){ add(r.testo); add(r.testoFinale); } });
    return out;
  };
  async function runSearch(ref, key){
    const sections = (LS.get("bm-master", "") || "").split("\n").filter(l => /^## \*\*/.test(l)).map(l => l.replace(/^## \*\*|\*\*$/g, "")).filter(s => !/Materiale di riferimento/i.test(s));
    const sources = (data.sources || []).filter(s => !/steven wright/i.test(s.name) && fileIdOf(s.url));
    if (!sections.length) throw new Error("Prima carica il Doc (tocca Accedi).");
    if (!sources.length) throw new Error("Nel Doc non trovo l'elenco dei file sorgente.");
    const model = LS.get("bm-amodel", CFG.model), day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    let found = 0, skipped = [];
    for (let i = 0; i < sources.length; i++){
      const s = sources[i];
      await ref.update({stato: "in_corso", avanzamento: Math.round(100 * i / sources.length), fase: "Leggo «" + s.name + "» (" + (i + 1) + " di " + sources.length + ")"});
      let src;
      try { src = await sourceContent(fileIdOf(s.url)); } catch (e) { if (e instanceof AuthError) throw e; skipped.push(s.name); continue; }
      if (src.skip){ skipped.push(s.name); continue; }
      if (!src.pdf && !(src.text || "").trim()) continue;
      await ref.update({fase: "L'IA legge «" + s.name + "» (" + (i + 1) + " di " + sources.length + ")"});
      const res = parseAiJson(await callClaude(buildSearchContent(src, sections, known()), key, model));
      const stamp = new Date().toISOString(), rows = [];
      res.battute.forEach(b => rows.push({id: "b-" + day + "-" + Date.now().toString(36) + rows.length, data: {aggiunta: stamp, fonte: s.name, fonteUrl: s.url, sezione: sections.indexOf(b.sezione) >= 0 ? b.sezione : sections[0], note: b.note, stato: "da_valutare", testo: b.testo}}));
      res.escluse.forEach(x => rows.push({id: "b-" + day + "-" + Date.now().toString(36) + rows.length, data: {aggiunta: stamp, fonte: s.name, fonteUrl: s.url, sezione: sections[0], note: "", motivo: x.motivo, stato: "esclusa", applicata: true, decisaIl: stamp, testo: x.testo}}));
      const fresh = freshCandidates(rows.map(r => Object.assign({id: r.id}, r.data)));
      const pend = new Set(); qRows.forEach(r => { if (r.stato === "da_valutare") candKeys(r).forEach(k => pend.add(k)); });
      const ok = new Set(fresh.filter(r => r.stato !== "da_valutare" || !candKeys(r).some(k => sameKnown(k, pend))).map(r => r.id));
      for (const r of rows){ if (ok.has(r.id)){ await db.collection("battute").doc(r.id).set(r.data); if (r.data.stato === "da_valutare") found++; } }
      await new Promise(res2 => setTimeout(res2, 40));
    }
    await ref.update({stato: "fatta", avanzamento: 100, fase: "Ricerca finita", trovate: found, saltati: skipped});
    return found;
  }
  async function startSearchAI(){
    const btn = $("searchBtn"), txt = $("searchTxt"), key = LS.get("bm-akey", "");
    if (!signedIn()){ toast("Accedi prima con Google."); return; }
    if (!key){ openSettings(); toast("Inserisci la chiave API di Anthropic."); return; }
    btn.disabled = true; btn.textContent = "Ricerca in corso…"; txt.hidden = true;
    clearTimeout(sHide); clearInterval(searchTimer); sReq = null; searchReqId = null; sSeen = 0; sLast = Date.now();
    const ref = await db.collection("richieste").add({tipo: "ricerca", stato: "in_attesa", richiesta: new Date().toISOString()});
    searchReqId = ref.id; searchAt = Date.now(); searchBase = qRows.filter(r => r.stato === "da_valutare").length; runSave();
    $("sProg").hidden = false; sRender(); searchTimer = setInterval(sTick, 1000);
    try { await runSearch(ref, key); }
    catch (e) { await ref.update({stato: "errore", errore: errText(e).slice(0, 160)}); }
  }
  const sb = $("searchBtn"), nb = sb.cloneNode(true); sb.replaceWith(nb); nb.addEventListener("click", startSearchAI);

  // ----- Impostazioni -----
  function updGState(){
    const el = $("gState"), b = $("gBtn"); if (!el) return;
    el.textContent = signedIn() ? "Collegato a Google" : (CFG.clientId ? "Non collegato" : "Manca l'ID cliente in config.js");
    b.textContent = signedIn() ? "Esci" : "Accedi con Google";
  }
  function openSettings(){ $("gKey").value = LS.get("bm-akey", ""); $("gModel").value = LS.get("bm-amodel", CFG.model); updGState(); $("sheetBack").classList.add("on"); $("gSheet").classList.add("on"); }
  $("gOpen").addEventListener("click", openSettings);
  $("gDone").addEventListener("click", () => { LS.set("bm-akey", $("gKey").value.trim()); LS.set("bm-amodel", $("gModel").value); closeSheet(); });
  $("gBtn").addEventListener("click", async () => { if (signedIn()){ signOut(); updGState(); setStatus("Accedi con Google per collegare il Doc e il Drive", false, "Accedi"); } else { await connect(true); } });

  Object.assign(window.BMG, {startSearchAI, connect, loadMaster});
  connect(false);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && signedIn()){ pull().catch(() => {}); } });
}
window.BMG = {init, docToMarkdown, buildInsertRequests, planRemoval, docxText, parseAiJson, buildSearchContent, mergeRemote, keyOf, _state: () => st, _db: db, SYSTEM};
})();
