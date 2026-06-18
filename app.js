/* World Cup 2026 Challenge Tracker
 * Pure client-side. Fetches ESPN live data, maps teams to owners (data.js),
 * computes group records and knockout payouts, renders the UI.
 */

const ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world";
const STANDINGS = "https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings";
const SEASON_RANGE = "20260611-20260719"; // tournament window

const money = (n) => (n < 0 ? "-$" : "$") + Math.abs(n).toFixed(2);
const moneyClass = (n) => (n > 0 ? "pos" : n < 0 ? "neg" : "muted");
const byCode = Object.fromEntries(TEAMS.map((t) => [t.code, t]));

// HTML-escape any value before inserting into innerHTML (defends against XSS in third-party API data)
const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC_MAP[c]);
// Only allow http(s) image URLs; reject anything else (e.g. javascript:, data:text/html)
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || "")) ? esc(u) : "");

/* ---- round detection from ESPN season slug ---- */
function roundOf(slug) {
  const s = (slug || "").toLowerCase();
  if (s.includes("group")) return "group";
  if (s.includes("32")) return "r32";
  if (s.includes("16")) return "r16";
  if (s.includes("quarter")) return "qf";
  if (s.includes("semi")) return "sf";
  if (s.includes("3rd") || s.includes("third")) return "third";
  if (s.includes("final")) return "final"; // checked after semi
  return "other";
}
const ROUND_LABEL = {
  group: "Group", r32: "Round of 32", r16: "Round of 16",
  qf: "Quarterfinal", sf: "Semifinal", third: "3rd-place match", final: "Final",
};

/* ---- data fetch ---- */
async function getJSON(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function loadAll() {
  const [standings, scoreboard] = await Promise.all([
    getJSON(STANDINGS),
    getJSON(`${ESPN}/scoreboard?dates=${SEASON_RANGE}`),
  ]);
  return { standings, scoreboard };
}

/* ---- parse standings: group records + advancement notes ---- */
function parseStandings(standings) {
  const groups = [];
  const teamInfo = Object.create(null); // code -> {...}; null-proto avoids prototype pollution from API keys
  for (const g of standings.children || []) {
    const rows = [];
    for (const e of g.standings.entries) {
      const stat = Object.create(null);
      for (const s of e.stats) stat[s.type] = s;
      const code = e.team.abbreviation;
      const info = {
        code,
        name: e.team.displayName,
        logo: (e.team.logos && e.team.logos[0] && e.team.logos[0].href) || null,
        group: g.name,
        rank: num(stat.rank),
        w: num(stat.wins), d: num(stat.ties), l: num(stat.losses),
        pts: num(stat.points),
        gd: num(stat.pointdifferential),
        gf: num(stat.pointsfor), ga: num(stat.pointsagainst),
        gp: num(stat.gamesplayed),
        record: (stat.total && stat.total.displayValue) || `${num(stat.wins)}-${num(stat.ties)}-${num(stat.losses)}`,
        note: e.note || null,
      };
      teamInfo[code] = info;
      rows.push(info);
    }
    rows.sort((a, b) => a.rank - b.rank);
    groups.push({ name: g.name, rows });
  }
  return { groups, teamInfo };
}
const num = (s) => (s && typeof s.value === "number" ? s.value : 0);

/* ---- parse scoreboard events ---- */
function parseEvents(scoreboard) {
  const matches = [];
  for (const ev of scoreboard.events || []) {
    const comp = ev.competitions[0];
    const round = roundOf(ev.season && ev.season.slug);
    const home = comp.competitors.find((c) => c.homeAway === "home");
    const away = comp.competitors.find((c) => c.homeAway === "away");
    const st = ev.status.type;
    matches.push({
      id: ev.id,
      date: ev.date,
      round,
      roundLabel: ROUND_LABEL[round] || "",
      completed: !!st.completed,
      state: st.state, // pre | in | post
      detail: st.shortDetail,
      home: side(home),
      away: side(away),
    });
  }
  matches.sort((a, b) => new Date(a.date) - new Date(b.date));
  return matches;
}
function side(c) {
  if (!c) return { code: "?", name: "TBD", score: null, winner: false, logo: null };
  return {
    code: c.team.abbreviation,
    name: c.team.displayName || c.team.name || c.team.abbreviation,
    score: c.score != null ? c.score : null,
    winner: !!c.winner,
    logo: (c.team.logos && c.team.logos[0] && c.team.logos[0].href) || null,
  };
}

/* ---- knockout payout engine ----
 * A team's payout is terminal: it is "earned" only once the team is
 * eliminated at a paying round or finishes 1st-4th. Still-alive teams = $0 so far.
 */
const ROUND_ORDER = { group: 0, r32: 1, r16: 2, qf: 3, sf: 4, third: 5, final: 5 };

function computePayouts(matches) {
  // gather completed knockout matches per team
  const played = Object.create(null); // code -> [{round, won}]; null-proto for API-keyed safety
  let finalPlayed = false, thirdPlayed = false;
  for (const m of matches) {
    if (m.round === "group" || !m.completed) continue;
    if (m.round === "final") finalPlayed = true;
    if (m.round === "third") thirdPlayed = true;
    for (const s of [m.home, m.away]) {
      if (!s || s.code === "?" || !byCode[s.code]) continue;
      (played[s.code] = played[s.code] || []).push({ round: m.round, won: s.winner });
    }
  }

  const result = {}; // code -> {earned, roundReached, alive, statusLabel}
  for (const code of Object.keys(byCode)) {
    const games = played[code] || [];
    if (!games.length) {
      result[code] = { earned: 0, roundReached: "group", alive: null, statusLabel: "Group stage" };
      continue;
    }
    // deepest round the team appeared in
    games.sort((a, b) => ROUND_ORDER[a.round] - ROUND_ORDER[b.round]);
    const last = games[games.length - 1];
    let earned = 0, alive = false, statusLabel = "";

    if (last.round === "final") {
      earned = last.won ? PAYOUTS.first : PAYOUTS.second;
      statusLabel = last.won ? "🏆 Champion" : "Runner-up";
    } else if (last.round === "third") {
      earned = last.won ? PAYOUTS.third : PAYOUTS.fourth;
      statusLabel = last.won ? "3rd place" : "4th place";
    } else if (last.round === "sf") {
      if (last.won) { alive = true; statusLabel = "In Final"; }
      else { alive = false; earned = PAYOUTS.fourth; statusLabel = "Lost SF — plays for 3rd"; } // 4th-place floor banked until 3rd-place match
    } else if (last.round === "qf") {
      if (last.won) { alive = true; statusLabel = "In Semifinal"; }
      else { earned = PAYOUTS.loseQF; statusLabel = "Lost in Quarterfinal"; }
    } else if (last.round === "r16") {
      if (last.won) { alive = true; statusLabel = "In Quarterfinal"; }
      else { earned = PAYOUTS.loseR16; statusLabel = "Lost in Round of 16"; }
    } else if (last.round === "r32") {
      if (last.won) { alive = true; statusLabel = "In Round of 16"; }
      else { earned = 0; statusLabel = "Lost in Round of 32"; }
    }
    result[code] = { earned, roundReached: last.round, alive, statusLabel };
  }
  return result;
}

/* ---- assemble per-team and per-owner views ---- */
function assemble(teamInfo, payouts) {
  const teams = TEAMS.map((t) => {
    const info = teamInfo[t.code] || {};
    const pay = payouts[t.code] || { earned: 0, roundReached: "group", alive: null, statusLabel: "" };
    return {
      ...t,
      name: info.name || t.code,
      logo: info.logo || null,
      group: info.group || "",
      record: info.record || "0-0-0",
      rank: info.rank || 0,
      pts: info.pts || 0,
      gd: info.gd || 0,
      gf: info.gf || 0,
      gp: info.gp || 0,
      note: info.note || null,
      earned: pay.earned,
      roundReached: pay.roundReached,
      alive: pay.alive,
      statusLabel: pay.statusLabel,
    };
  });

  const owners = {};
  for (const o of Object.keys(OWNER_NAMES)) {
    owners[o] = { id: o, name: OWNER_NAMES[o], color: OWNER_COLORS[o], cost: 0, earned: 0, teams: [] };
  }
  for (const t of teams) {
    const o = owners[t.owner];
    if (!o) continue;
    o.cost += t.cost;
    o.earned += t.earned;
    o.teams.push(t);
  }
  const ownerList = Object.values(owners).map((o) => ({
    ...o,
    cost: round2(o.cost),
    earned: round2(o.earned),
    net: round2(o.earned - o.cost),
  }));
  ownerList.sort((a, b) => b.net - a.net || b.earned - a.earned);
  return { teams, ownerList };
}
const round2 = (n) => Math.round(n * 100) / 100;

/* ---- biggest steals / busts: performance vs price ----
 * actual rank (how the team is really doing) vs expected rank (implied by cost).
 * surprise = expectedRank - actualRank. Positive = overachieving for its price.
 */
const ROUND_PROGRESS = { group: 0, r32: 1, r16: 2, qf: 3, sf: 4, third: 5, final: 6 };
function perfScore(t) {
  // knockout progress dominates; group form (pts, goal diff, goals) breaks ties
  return (ROUND_PROGRESS[t.roundReached] || 0) * 100000 + (t.pts || 0) * 1000 + (t.gd || 0) * 10 + (t.gf || 0);
}
function computeValue(teams) {
  const list = teams.filter((t) => t.gp > 0 || t.roundReached !== "group"); // teams that have played
  if (!list.length) return { steals: [], busts: [], mode: "form" };

  const byPerf = [...list].sort((a, b) => perfScore(b) - perfScore(a));
  const byCost = [...list].sort((a, b) => b.cost - a.cost);
  const actualRank = new Map(byPerf.map((t, i) => [t.code, i + 1]));
  const expectedRank = new Map(byCost.map((t, i) => [t.code, i + 1]));

  const scored = list.map((t) => {
    const aR = actualRank.get(t.code), eR = expectedRank.get(t.code);
    return {
      ...t,
      actualRank: aR,
      expectedRank: eR,
      surprise: eR - aR,            // + = steal, - = bust
      profit: round2(t.earned - t.cost),
    };
  });

  // Money mode once any payout exists: real profit decides it (a cheap champion is the ultimate steal).
  // Still-alive teams are excluded — their story isn't over, so they can't be a "bust" yet.
  if (teams.some((t) => t.earned > 0)) {
    const locked = scored.filter((t) => t.alive !== true);
    const steals = [...locked].sort((a, b) => b.profit - a.profit || b.surprise - a.surprise).slice(0, 5);
    const busts = [...locked].sort((a, b) => a.profit - b.profit || a.surprise - b.surprise).slice(0, 5);
    return { steals, busts, mode: "money" };
  }
  // Group stage: no money yet, so judge performance vs price.
  const steals = scored.filter((t) => t.surprise > 0)
    .sort((a, b) => b.surprise - a.surprise || b.profit - a.profit).slice(0, 5);
  const busts = scored.filter((t) => t.surprise < 0)
    .sort((a, b) => a.surprise - b.surprise || a.profit - b.profit).slice(0, 5);
  return { steals, busts, mode: "form" };
}

/* ====================== RENDER ====================== */
const ownerColorFor = (code) => OWNER_COLORS[byCode[code] ? byCode[code].owner : ""] || "transparent";

function renderHero(owners, phase) {
  const el = document.getElementById("hero");
  if (!el || !owners.length) return;
  const leader = owners[0];
  el.innerHTML = `
    <div class="hero-stat"><span class="eyebrow">Prize pool</span><b>$800</b></div>
    <div class="hero-stat"><span class="eyebrow">Managers</span><b>${owners.length}</b></div>
    <div class="hero-stat"><span class="eyebrow">Stage</span><b>${esc(phase || "—")}</b></div>
    <div class="hero-stat hero-leader"><span class="eyebrow">Leading</span>
      <b><span class="dot" style="background:${esc(leader.color)}"></span>${esc(leader.name)}</b></div>`;
}

function renderLeaderboard(owners) {
  // break-even race: bars extend from a center zero line — left/red for down, right/green for up
  const maxAbs = Math.max(1, ...owners.map((o) => Math.abs(o.net)));
  const rows = owners.map((o, i) => {
    const pct = Math.min(50, (Math.abs(o.net) / maxAbs) * 50);
    const side = o.net < 0 ? "right:50%" : "left:50%";
    const barCls = o.net > 0 ? "pos" : o.net < 0 ? "neg" : "zero";
    return `
      <div class="srow ${i === 0 ? "leader" : ""}">
        <div class="srank">${i + 1}</div>
        <div class="sname">
          <span class="dot" style="background:${esc(o.color)}"></span>
          <span class="snm">${esc(o.name)}</span>
          <span class="ssub">paid ${money(o.cost)} · won ${money(o.earned)}</span>
        </div>
        <div class="strack" aria-hidden="true"><div class="sbar ${barCls}" style="${side};width:${pct}%"></div></div>
        <div class="sfig ${moneyClass(o.net)}">${money(o.net)}</div>
      </div>`;
  }).join("");
  document.getElementById("leaderboard-body").innerHTML = `
    <div class="standings-head"><span>Pos</span><span>Manager</span><span class="sh-track">Down ◄ break-even ► up</span><span>Standing</span></div>
    <div class="standings">${rows}</div>`;
}

function renderValue(value) {
  const el = document.getElementById("value-panel");
  if (!el) return;
  if (!value.steals.length && !value.busts.length) { el.innerHTML = ""; return; }

  const money_mode = value.mode === "money";
  const row = (t) => {
    const o = byCode[t.code];
    const status = t.statusLabel && t.statusLabel !== "Group stage" ? t.statusLabel : t.record;
    let metric;
    if (money_mode) {
      metric = `<span class="vp-profit ${moneyClass(t.profit)}">${money(t.profit)}</span>`;
    } else {
      const dir = t.surprise > 0 ? "▲" : "▼";
      metric = `<span class="vp-delta ${t.surprise > 0 ? "pos" : "neg"}">${dir} ${Math.abs(t.surprise)}</span>`;
    }
    return `
      <li class="vp-row">
        <span class="team-name">
          <span class="dot" style="background:${esc(OWNER_COLORS[o ? o.owner : ""])}" title="${o ? esc(OWNER_NAMES[o.owner]) : ""}"></span>
          ${t.logo ? `<img class="team-logo" src="${safeUrl(t.logo)}" alt="">` : ""}
          <b>${esc(t.name)}</b> <span class="team-code">${o ? esc(o.owner) : ""} · cost ${money(t.cost)}</span>
        </span>
        <span class="vp-meta">
          <span class="vp-status">${esc(status)}</span>
          ${metric}
        </span>
      </li>`;
  };

  const stealSub = money_mode ? "Most money made vs what they cost" : "Outperforming their price tag";
  const bustSub = money_mode ? "Least money made vs what they cost" : "Underperforming what they cost";
  const note = money_mode
    ? "Profit = winnings &minus; cost. Teams still alive are excluded until their run ends."
    : "Rank moved (▲/▼) = how many spots a team is doing better/worse than its cost implied.";

  el.innerHTML = `
    <div class="vp-grid">
      <div class="vp-card steal">
        <h4>💎 Biggest Steals</h4>
        <p class="vp-sub">${stealSub}</p>
        <ul class="vp-list">${value.steals.map(row).join("") || '<li class="vp-empty">—</li>'}</ul>
      </div>
      <div class="vp-card bust">
        <h4>💀 Biggest Busts</h4>
        <p class="vp-sub">${bustSub}</p>
        <ul class="vp-list">${value.busts.map(row).join("") || '<li class="vp-empty">—</li>'}</ul>
      </div>
    </div>
    <p class="vp-note">${note}</p>`;
}

function teamStatusPill(t) {
  if (t.statusLabel === "Group stage" || t.roundReached === "group") {
    if (t.note && /advance/i.test(t.note.description || "")) return `<span class="pill adv">Advancing</span>`;
    return `<span class="pill">Group</span>`;
  }
  if (t.alive) return `<span class="pill alive">${esc(t.statusLabel)}</span>`;
  return `<span class="pill out">${esc(t.statusLabel)}</span>`;
}

function renderOwners(owners) {
  document.getElementById("owners-body").innerHTML = owners.map((o) => {
    const teams = [...o.teams].sort((a, b) => b.cost - a.cost);
    const lis = teams.map((t) => `
      <li>
        <span class="team-name">
          ${t.logo ? `<img class="team-logo" src="${safeUrl(t.logo)}" alt="">` : ""}
          ${esc(t.name)} <span class="team-code">${esc(t.group || "")}</span>
        </span>
        <span class="rec" title="Group record (W-D-L)">${esc(t.record)}</span>
        <span class="team-pay">${teamStatusPill(t)}</span>
      </li>`).join("");
    return `
      <div class="owner-card">
        <header>
          <h3><span class="dot" style="background:${esc(o.color)}"></span>${esc(o.name)}</h3>
          <span class="owner-net ${moneyClass(o.net)}">${money(o.net)}</span>
        </header>
        <div class="owner-sub">
          <span>Cost <b>${money(o.cost)}</b></span>
          <span>Winnings <b>${money(o.earned)}</b></span>
          <span>${o.teams.length} teams</span>
        </div>
        <ul class="team-list">${lis}</ul>
      </div>`;
  }).join("");
}

function renderGroups(groups) {
  document.getElementById("groups-body").innerHTML = groups.map((g) => {
    const letter = (g.name.match(/[A-Z]\s*$/i) || [g.name.slice(-1)])[0].trim();
    const rows = g.rows.map((t) => {
      const owner = byCode[t.code] ? byCode[t.code].owner : "";
      const qual = t.rank <= 2 ? "qual" : "";
      return `<tr class="${qual}">
        <td class="tm">${esc(t.code)}<span class="owner-tag" style="color:${esc(OWNER_COLORS[owner] || "var(--muted)")}">${esc(owner)}</span></td>
        <td>${t.gp}</td><td>${t.w}</td><td>${t.d}</td><td>${t.l}</td>
        <td>${t.gd > 0 ? "+" + t.gd : t.gd}</td><td><b>${t.pts}</b></td>
      </tr>`;
    }).join("");
    return `
      <div class="group-card">
        <div class="grp-head"><span class="grp-letter">${esc(letter)}</span><span class="eyebrow">Group</span></div>
        <table class="grp">
          <thead><tr><th>Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Pts</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }).join("");
}

/* local YYYY-MM-DD key for splitting/sorting by calendar day */
const dayKey = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};
const todayKey = () => dayKey(new Date());
const fmtDay = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const fmtTime = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

function matchCard(m) {
  const isOwned = (code) => !!byCode[code];
  const owned = isOwned(m.home.code) || isOwned(m.away.code) ? "owned" : "";
  const stateCls = m.state === "in" ? "live" : "";
  const liveBadge = m.state === "in" ? `<span class="live-badge">LIVE</span> ` : "";
  const scoreTxt = m.state === "pre" ? "v" : `${esc(m.home.score ?? "")} – ${esc(m.away.score ?? "")}`;
  const stateTxt = m.state === "pre" ? `${esc(fmtTime(m.date))} · ${esc(m.roundLabel)}` : `${liveBadge}${esc(m.detail)} · ${esc(m.roundLabel)}`;
  const hc = m.completed ? (m.home.winner ? "win" : "loss") : "";
  const ac = m.completed ? (m.away.winner ? "win" : "loss") : "";
  return `
    <div class="match ${owned}">
      <div class="side home ${hc}">
        ${tag(m.home.code)} ${m.home.logo ? `<img class="team-logo" src="${safeUrl(m.home.logo)}" alt="">` : ""}
        <span>${esc(m.home.name)}</span>
      </div>
      <div>
        <div class="score">${scoreTxt}</div>
        <div class="state ${stateCls}">${stateTxt}</div>
      </div>
      <div class="side away ${ac}">
        <span>${esc(m.away.name)}</span>
        ${m.away.logo ? `<img class="team-logo" src="${safeUrl(m.away.logo)}" alt="">` : ""} ${tag(m.away.code)}
      </div>
    </div>`;
}

/* group ascending-sorted matches by calendar day; returns [{key,label,items}] in ascending day order */
function groupByDay(matches) {
  const today = todayKey();
  const groups = new Map();
  for (const m of matches) {
    const k = dayKey(m.date);
    if (!groups.has(k)) {
      const label = k === today ? `Today · ${fmtDay(m.date)}` : fmtDay(m.date);
      groups.set(k, { key: k, label, items: [] });
    }
    groups.get(k).items.push(m);
  }
  return [...groups.values()];
}

function renderDayGroups(elId, groups, emptyMsg) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = groups.length
    ? groups.map((g) => `<div class="day-group"><h4 class="day-head">${g.label}</h4>${g.items.map(matchCard).join("")}</div>`).join("")
    : `<p class="section-note">${emptyMsg}</p>`;
}

/* Fixtures: upcoming only — tomorrow onward, soonest day first */
function renderFixtures(matches) {
  const today = todayKey();
  const upcoming = matches.filter((m) => dayKey(m.date) > today);
  renderDayGroups("fixtures-body", groupByDay(upcoming), "No upcoming fixtures — that's the end of the schedule. 🏆");
}

/* Scores: today (even if not started) + every prior day back to the opener, newest day first */
function renderScores(matches) {
  const today = todayKey();
  const played = matches.filter((m) => dayKey(m.date) <= today);
  renderDayGroups("scores-body", groupByDay(played).reverse(), "No matches yet — the tournament hasn't kicked off.");
}

function tag(code) {
  const o = byCode[code];
  if (!o) return "";
  return `<span class="owner-chip" style="background:${esc(OWNER_COLORS[o.owner])}" title="Owner: ${esc(OWNER_NAMES[o.owner])}">${esc(o.owner)}</span>`;
}

/* ====================== BOOT ====================== */
let cache = null;
function renderAll() {
  if (!cache) return;
  renderHero(cache.ownerList, cache.phase);
  renderLeaderboard(cache.ownerList);
  renderValue(cache.value);
  renderOwners(cache.ownerList);
  renderGroups(cache.groups);
  renderScores(cache.matches);
  renderFixtures(cache.matches);
}

async function refresh() {
  const err = document.getElementById("error");
  const btn = document.getElementById("refresh");
  err.classList.add("hidden");
  btn.disabled = true; btn.textContent = "↻ …";
  try {
    const { standings, scoreboard } = await loadAll();
    const { groups, teamInfo } = parseStandings(standings);
    const matches = parseEvents(scoreboard);
    const payouts = computePayouts(matches);
    const { teams, ownerList } = assemble(teamInfo, payouts);
    const value = computeValue(teams);
    const phase = (scoreboard.leagues && scoreboard.leagues[0] && scoreboard.leagues[0].season &&
      scoreboard.leagues[0].season.type && scoreboard.leagues[0].season.type.name) || "World Cup";
    cache = { groups, teams, ownerList, matches, value, phase };
    renderAll();

    document.getElementById("phase-badge").textContent = phase;
    document.getElementById("updated").textContent =
      "Updated " + new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch (e) {
    err.textContent = "Couldn't load live data from ESPN: " + e.message + " — try Refresh in a moment.";
    err.classList.remove("hidden");
  } finally {
    btn.disabled = false; btn.textContent = "↻ Refresh";
  }
}

// tab switching (deep-linkable via #hash)
function activateTab(name) {
  const valid = ["leaderboard", "owners", "groups", "scores", "fixtures"];
  if (!valid.includes(name)) name = "leaderboard";
  document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("active", x.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((s) => s.classList.toggle("active", s.id === name));
}
document.getElementById("tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (!b) return;
  location.hash = b.dataset.tab;
  activateTab(b.dataset.tab);
});
window.addEventListener("hashchange", () => activateTab(location.hash.slice(1)));
if (location.hash) activateTab(location.hash.slice(1));
document.getElementById("refresh").addEventListener("click", refresh);

refresh();
setInterval(refresh, 90 * 1000); // auto-refresh every 90s
