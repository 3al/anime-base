---
type: reference
domain: meta
tags:
  - dashboard
  - health
aliases:
  - Здоровье волта
---

# Здоровье волта

> Живые срезы состояния волта. 

## Рейтинг моделей

> Качество моделей-авторов по леджеру — вью `ledger-protocol.md §7`: `avg(score)` по `authored_model × audit_type`, фильтр **`pristine=true` И судья `claude-opus-*`** (только чистая авторская работа под референс-судьёй; judge-починенные и не-референс замеры исключены). Шкала 1–10.
>
> **Две оси ранжируются раздельно** — `structural` (`/audit-by-creator`, конформность форме) и `content` (`/audit-note`, фактология/проза) измеряют разное; доверие к модели копится **per-axis** (можно снять дорогую ось для модели, надёжной именно на ней). Композит по осям намеренно не считается.
>
> **Относительная мера при одном судье, не абсолют** (§7). Столбец `до n≥N` — runway до «устаканившейся» оценки (эвристика покрытия, НЕ формальная стат-значимость). Полная история (включая `⚠` non-pristine) — ниже.

```dataviewjs
const LEDGER = "SYSTEM/model_quality.jsonl";
const N_TARGET = 5;   // порог «стабильной» оценки на ячейку model×axis (эвристика, не формальная значимость)
let raw = null;
try { raw = await dv.io.load(LEDGER); } catch (e) { raw = null; }
if (!raw) { dv.paragraph(`⚠ Леджер не найден или пуст: \`${LEDGER}\``); return; }

let malformed = 0;
const rows = raw.split("\n").filter(l => l.trim())
  .map(l => { try { return JSON.parse(l); } catch { malformed++; return null; } })
  .filter(Boolean);
if (malformed > 0) dv.paragraph(`⚠ **${malformed} строк(и) леджера не распарсились** — пропущены.`);

// вью «качество моделей» (§7): только pristine=true под референс-судьёй claude-opus-*
const elig = rows.filter(r => r.pristine === true && String(r.judge_model).startsWith("claude-opus"));
const judges = new Set(elig.map(r => r.judge_model));

// ячейки model × axis -> {sum, n}
const agg = {};
for (const r of elig) {
  const k = r.authored_model + "|" + r.audit_type;
  const a = (agg[k] = agg[k] || { model: r.authored_model, axis: r.audit_type, sum: 0, n: 0 });
  a.sum += r.score; a.n += 1;
}
const cells = Object.values(agg);

const renderAxis = (axis, title) => {
  const list = cells.filter(c => c.axis === axis).sort((a, b) => b.sum / b.n - a.sum / a.n);
  dv.header(4, title);
  if (!list.length) { dv.paragraph("— нет pristine-замеров под референс-судьёй."); return; }
  dv.table(["Модель", "avg", "n", `до n≥${N_TARGET}`],
    list.map(c => {
      const need = Math.max(0, N_TARGET - c.n);
      return [c.model, (c.sum / c.n).toFixed(1), String(c.n), need ? `+${need}` : "✓"];
    })
  );
};

if (!cells.length) {
  dv.paragraph("Пока нет ни одного pristine-замера под референс-судьёй — рейтинг пуст.");
} else {
  renderAxis("structural", "Structural — audit-by-creator");
  renderAxis("content", "Content — audit-note");
  const stable = cells.filter(c => c.n >= N_TARGET).length;
  const totalNeed = cells.reduce((s, c) => s + Math.max(0, N_TARGET - c.n), 0);
  dv.paragraph(`Учтено ${elig.length}/${rows.length} pristine-замеров · судья: ${[...judges].join(", ") || "—"}. **Стабильность:** ${stable}/${cells.length} ячеек (model×axis) достигли n≥${N_TARGET}; до порога по уже начатым ячейкам — ещё **${totalNeed}** замер(ов) (каждая новая модель/ось добавит свою ячейку). Порог n≥${N_TARGET} — эвристика «оценка устаканилась», не формальная значимость (для неё нужны дисперсия + модель шума судьи).`);
}
```

## Покрытие аудита

> Источник — `SYSTEM/model_quality.jsonl` (леджер качества моделей, append-only). Контракт записи: `.claude/skills/audit-by-creator/references/ledger-protocol.md`.
>
> `structural` = `/audit-by-creator`, `content` = `/audit-note`. `✓` pristine (чистая работа автора), `⚠` non-pristine (состояние частично исправлено до замера → из чистого сравнения моделей исключается).

```dataviewjs
const LEDGER = "SYSTEM/model_quality.jsonl";
let raw = null;
try { raw = await dv.io.load(LEDGER); } catch (e) { raw = null; }
if (!raw) { dv.paragraph(`⚠ Леджер не найден или пуст: \`${LEDGER}\``); return; }

let malformed = 0;
const rows = raw.split("\n").filter(l => l.trim())
  .map(l => { try { return JSON.parse(l); } catch { malformed++; return null; } })
  .filter(Boolean);
if (malformed > 0) dv.paragraph(`⚠ **${malformed} строк(и) леджера не распарсились** (битый JSON) — пропущены и НЕ учтены ниже. Проверь \`SYSTEM/model_quality.jsonl\`.`);

// последняя запись по (note, audit_type)
const latest = {};
for (const r of rows) {
  const k = r.note + "|" + r.audit_type;
  if (!latest[k] || r.ts > latest[k].ts) latest[k] = r;
}
const byNote = {};
for (const k in latest) {
  const r = latest[k];
  (byNote[r.note] = byNote[r.note] || {})[r.audit_type] = r;
}

const cell = e => e ? `${e.score}/10 ${e.pristine ? "✓" : "⚠"}` : "—";
const lastTs = p => {
  const n = byNote[p.file.path];
  if (!n) return null;
  return [n.structural, n.content].filter(Boolean).map(e => e.ts).sort().slice(-1)[0] || null;
};

// аудированные сверху → по свежести последнего аудита убыв.; непроаудированные ниже → по пути
const cards = dv.pages().where(p => p.note_kind).array();
cards.sort((a, b) => {
  const ta = lastTs(a), tb = lastTs(b);
  if (ta && tb) return tb.localeCompare(ta);
  if (ta) return -1;
  if (tb) return 1;
  // оба непроаудированы → по created (новые выше), при равенстве — по пути
  const ca = String(a.created ?? ""), cb = String(b.created ?? "");
  return cb.localeCompare(ca) || a.file.path.localeCompare(b.file.path);
});

dv.header(3, "Покрытие по карточкам");
dv.table(
  ["Карточка", "kind", "structural", "content", "автор", "судья", "посл. аудит"],
  cards.map(p => {
    const n = byNote[p.file.path] || {};
    const s = n.structural, c = n.content, any = s || c;
    const lt = lastTs(p);
    const last = lt ? lt.slice(0, 10) : "—";
    return [
      p.file.link, p.note_kind, cell(s), cell(c),
      any ? any.authored_model : (p.co_authored ?? "—"),
      any ? any.judge_model : "—", last
    ];
  })
);

const total = cards.length, audited = Object.keys(byNote).length;
const nS = Object.values(latest).filter(e => e.audit_type === "structural").length;
const nC = Object.values(latest).filter(e => e.audit_type === "content").length;
dv.paragraph(`**Покрытие:** ${audited}/${total} карточек с ≥1 аудитом · structural ${nS} · content ${nC} · всего записей ${rows.length}. Легенда: \`✓\` pristine, \`⚠\` non-pristine.`);

dv.header(3, "История леджера (новые сверху)");
dv.table(
  ["ts (UTC)", "карточка", "ось", "score", "судья", "pristine", "причины"],
  rows.slice().sort((a, b) => b.ts.localeCompare(a.ts)).map(r => [
    r.ts.slice(0, 16).replace("T", " "),
    r.note.split("/").pop().replace(".md", ""),
    r.audit_type, `${r.score}/10`, r.judge_model,
    r.pristine ? "✓" : "⚠",
    (r.reasons && r.reasons.length) ? r.reasons.join("; ") : "—"
  ])
);
```
