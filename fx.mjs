// Обновляет курс Банка России в config.json (раздел fx). Остальные разделы не трогает.
// Запускается в GitHub Actions дважды в день. Источник — cbr.ru, запасной — зеркало cbr-xml-daily.ru.
// Защита: нужные валюты на месте, EUR в разумных пределах, скачок любой валюты > 25 % — отказ.
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = new URL('./config.json', import.meta.url);
const CODES = ['EUR', 'USD', 'CNY', 'JPY', 'KRW', 'AED', 'KZT', 'BYN', 'KGS'];
const REQUIRED = ['EUR', 'USD', 'CNY', 'JPY', 'KRW', 'AED'];
const mskToday = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);

async function get(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'rastamozhka-fx/1.0' } });
    if (!r.ok) throw new Error(`${url} → ${r.status}`);
    return r;
  } finally {
    clearTimeout(timer);
  }
}

async function fromCbr(day) {
  const [y, m, d] = day.split('-');
  const r = await get(`https://www.cbr.ru/scripts/XML_daily.asp?date_req=${d}/${m}/${y}`);
  const xml = new TextDecoder('windows-1251').decode(await r.arrayBuffer());
  const dm = xml.match(/<ValCurs[^>]*Date="(\d\d)\.(\d\d)\.(\d{4})"/);
  if (!dm) throw new Error('cbr: нет даты');
  const rates = {};
  for (const v of xml.matchAll(/<Valute[^>]*>([\s\S]*?)<\/Valute>/g)) {
    const code = v[1].match(/<CharCode>(\w+)<\/CharCode>/)?.[1];
    if (!code || !CODES.includes(code)) continue;
    const nominal = Number(v[1].match(/<Nominal>(\d+)<\/Nominal>/)?.[1] ?? 1);
    const unit = v[1].match(/<VunitRate>([\d,]+)<\/VunitRate>/)?.[1];
    const value = v[1].match(/<Value>([\d,]+)<\/Value>/)?.[1];
    const rate = unit ? Number(unit.replace(',', '.')) : Number(value.replace(',', '.')) / nominal;
    rates[code] = Number(rate.toPrecision(7));
  }
  return { date: `${dm[3]}-${dm[2]}-${dm[1]}`, rates };
}

async function fromMirror() {
  const j = await (await get('https://www.cbr-xml-daily.ru/daily_json.js')).json();
  const rates = {};
  for (const c of CODES) {
    const v = j.Valute?.[c];
    if (v) rates[c] = Number((v.Value / v.Nominal).toPrecision(7));
  }
  return { date: String(j.Date).slice(0, 10), rates };
}

function check(fx, prev) {
  for (const c of REQUIRED) if (!(fx.rates[c] > 0)) throw new Error(`нет курса ${c}`);
  if (fx.rates.EUR < 30 || fx.rates.EUR > 400) throw new Error(`странный курс EUR ${fx.rates.EUR}`);
  for (const [c, v] of Object.entries(fx.rates)) {
    const p = prev?.rates?.[c];
    if (p && Math.abs(v / p - 1) > 0.25) throw new Error(`скачок ${c}: ${p} → ${v}`);
  }
}

const raw = readFileSync(FILE, 'utf8');
const cfg = JSON.parse(raw);
const errors = [];
let fx = null;
for (const src of [() => fromCbr(mskToday()), fromMirror]) {
  try {
    fx = await src();
    check(fx, cfg.fx);
    break;
  } catch (e) {
    errors.push(e.message);
    fx = null;
  }
}
if (!fx) {
  console.error('Курс не получен:', errors.join(' | '));
  process.exit(1);
}
if (fx.date < cfg.fx.date) {
  console.log(`Курс ${fx.date} старее сохранённого ${cfg.fx.date}, не трогаю`);
  process.exit(0);
}
const next = { date: fx.date, source: 'Банк России', rates: fx.rates };
if (JSON.stringify(next) === JSON.stringify(cfg.fx)) {
  console.log(`Без изменений: курс на ${fx.date}`);
  process.exit(0);
}
cfg.fx = next;
writeFileSync(FILE, JSON.stringify(cfg) + '\n');
console.log(`Обновлён курс ЦБ на ${fx.date}: EUR ${fx.rates.EUR}`);
