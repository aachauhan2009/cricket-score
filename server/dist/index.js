import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import { createServer } from "http";
import { Server as IOServer } from "socket.io";
import session from "express-session";
import { StatusCodes as HTTP } from "http-status-codes";
import { Team, Player, Match, MatchState, Innings, BallEvent, PlayerStats, GroupTeam, Group, Tournament, MatchResult } from "./models.js";
// import path from "path";
// import { fileURLToPath } from "url";
// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);
// Where the built frontend lives:
//  - set STATIC_DIR=/absolute/path/to/web/dist in prod
//  - by default, looks for ./public next to index.ts
// const STATIC_DIR = process.env.STATIC_DIR
//   ? path.resolve(process.env.STATIC_DIR)
//   : path.resolve(__dirname, "public");
/* ------------ Config ------------ */
const PORT = Number(process.env.PORT ?? 4000);
const MONGO_URI = process.env.MONGO_URI ?? "mongodb://localhost:27017/cricket";
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:5173";
const SESSION_SECRET = process.env.SESSION_SECRET ?? "devsecret";
const ADMIN_USER = process.env.ADMIN_USER ?? "admin";
const ADMIN_PASS = process.env.ADMIN_PASS ?? "GLSCricket@12345";
const ALLOWED_OVERS = new Set([6, 8, 10, 20]);
await mongoose.connect(MONGO_URI);
const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json({ limit: "5mb" }));
app.use(session({
    name: "sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: false, // set true if serving over HTTPS + sameSite:'none'
        maxAge: 7 * 24 * 60 * 60 * 1000,
    },
}));
// app.use(express.static(STATIC_DIR, {
//   index: false,                 // we'll send index.html manually (SPA)
//   maxAge: "1h",                 // cache static files for a bit
// }));
// // SPA fallback: send index.html for non-API, non-Socket.IO routes
// app.get("*", (req, res, next) => {
//   // Don't hijack API or socket paths
//   if (req.path.startsWith("/api") || req.path.startsWith("/socket.io")) return next();
//   const indexFile = path.join(STATIC_DIR, "index.html");
//   res.sendFile(indexFile, (err) => {
//     if (err) next(err);
//   });
// });
const http = createServer(app);
const io = new IOServer(http, { cors: { origin: CORS_ORIGIN, credentials: true } });
/* ------------ Helpers ------------ */
const ch = (id) => `match:${id}`;
const ballsFromOvers = (o) => o * 6;
const maxOversPerBowler = (totalOvers) => Math.ceil((totalOvers || 6) / 5);
const authRequired = (req, res, next) => {
    if (req.session?.isAdmin)
        return next();
    return res.status(401).json({ error: "Unauthorized" });
};
async function eligibleBatters(matchId, st, inn) {
    const battingTeamId = String(inn.battingTeamId);
    const all = await Player.find({ teamId: battingTeamId }).select("_id fullName teamId").lean();
    const outsRows = await PlayerStats.find({ matchId, teamId: battingTeamId, isOut: true }).select("playerId").lean();
    const outSet = new Set(outsRows.map(r => String(r.playerId)));
    const onField = new Set([String(st.strikerId || ""), String(st.nonStrikerId || "")].filter(Boolean));
    return all.filter(p => !outSet.has(String(p._id)) && !onField.has(String(p._id)));
}
async function wicketsAllOutThreshold(inn) {
    const count = await Player.countDocuments({ teamId: inn.battingTeamId });
    return Math.max(0, count - 1); // all-out when wickets == batters - 1
}
async function totalsByTeam(matchId) {
    const inns = await Innings.find({ matchId }).lean();
    const map = {};
    for (const i of inns) {
        const k = String(i.battingTeamId);
        map[k] = (map[k] ?? 0) + (i.runs || 0);
    }
    return { inns, map };
}
async function finishMatchNow(match, winnerTeamId, isTie) {
    const { map } = await totalsByTeam(String(match._id));
    await Match.updateOne({ _id: match._id }, { $set: { status: "finished" } });
    await MatchResult.updateOne({ matchId: match._id }, { $set: { winnerTeamId: winnerTeamId || undefined, loserTeamId: winnerTeamId ? (String(winnerTeamId) === String(match.teamAId) ? match.teamBId : match.teamAId) : undefined, isTie, isNoResult: false } }, { upsert: true });
    io.to(ch(String(match._id))).emit("match:finished", {
        teamAId: match.teamAId, teamBId: match.teamBId,
        totalA: map[String(match.teamAId)] || 0,
        totalB: map[String(match.teamBId)] || 0,
        winnerTeamId: winnerTeamId || undefined,
        isTie
    });
}
/* ------------ Auth ------------ */
app.post("/api/auth/login", (req, res) => {
    const { username, password } = req.body || {};
    if (username === ADMIN_USER && password === ADMIN_PASS) {
        req.session.isAdmin = true;
        return res.json({ ok: true, isAdmin: true });
    }
    return res.status(401).json({ error: "Invalid credentials" });
});
app.post("/api/auth/logout", (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
});
app.get("/api/auth/me", (req, res) => {
    res.json({ isAdmin: !!req.session?.isAdmin });
});
/* ------------ Admin Import (protected) ------------ */
app.post("/api/admin/import", authRequired, async (req, res) => {
    try {
        const p = req.body || {};
        let tournament = null;
        if (p.tournament?.name) {
            tournament = await Tournament.findOneAndUpdate({ name: p.tournament.name }, { $set: p.tournament }, { upsert: true, new: true });
        }
        const teamMap = new Map();
        for (const t of (p.teams || [])) {
            const doc = await Team.findOneAndUpdate({ name: t.name }, { $set: t }, { upsert: true, new: true });
            teamMap.set(t.name, doc);
        }
        for (const pl of (p.players || [])) {
            const team = teamMap.get(pl.teamName) || await Team.findOne({ name: pl.teamName });
            if (!team)
                continue;
            await Player.findOneAndUpdate({ teamId: team._id, fullName: pl.fullName }, { $set: { teamId: team._id, fullName: pl.fullName, role: pl.role, battingStyle: pl.battingStyle, bowlingStyle: pl.bowlingStyle } }, { upsert: true, new: true });
        }
        const groupMap = new Map();
        for (const g of (p.groups || [])) {
            const doc = await Group.findOneAndUpdate({ tournamentId: tournament?._id, name: g.name }, { $set: { tournamentId: tournament?._id, name: g.name } }, { upsert: true, new: true });
            groupMap.set(g.name, doc);
        }
        for (const gt of (p.groupTeams || [])) {
            const g = groupMap.get(gt.groupName) || await Group.findOne({ name: gt.groupName, tournamentId: tournament?._id });
            const t = teamMap.get(gt.teamName) || await Team.findOne({ name: gt.teamName });
            if (!g || !t)
                continue;
            await GroupTeam.findOneAndUpdate({ groupId: g._id, teamId: t._id }, { $set: { groupId: g._id, teamId: t._id } }, { upsert: true, new: true });
        }
        for (const m of (p.matches || [])) {
            const g = groupMap.get(m.groupName) || await Group.findOne({ name: m.groupName, tournamentId: tournament?._id });
            const a = teamMap.get(m.teamA) || await Team.findOne({ name: m.teamA });
            const b = teamMap.get(m.teamB) || await Team.findOne({ name: m.teamB });
            if (!a || !b)
                continue;
            const ovs = Number(m.maxOvers ?? 6);
            await Match.findOneAndUpdate({ title: m.title }, {
                $set: {
                    title: m.title,
                    teamAId: a._id, teamBId: b._id,
                    maxOvers: ALLOWED_OVERS.has(ovs) ? ovs : 6,
                    status: m.status ?? "scheduled",
                    tournamentId: tournament?._id,
                    groupId: g?._id
                }
            }, { upsert: true, new: true });
        }
        res.json({ ok: true });
    }
    catch (e) {
        console.error(e);
        res.status(400).json({ error: e.message });
    }
});
/* ------------ Public Reads ------------ */
app.get("/api/tournaments", async (_req, res) => res.json(await Tournament.find().sort("-createdAt")));
app.get("/api/groups", async (req, res) => {
    const tournamentId = req.query.tournamentId;
    const q = {};
    if (tournamentId)
        q.tournamentId = tournamentId;
    res.json(await Group.find(q).sort("name"));
});
app.get("/api/matches", async (req, res) => {
    const groupId = req.query.groupId;
    const status = req.query.status;
    const q = {};
    if (groupId)
        q.groupId = groupId;
    if (status)
        q.status = status;
    res.json(await Match.find(q).sort("createdAt"));
});
app.get("/api/teams", async (_req, res) => res.json(await Team.find().sort("name")));
app.get("/api/players", async (req, res) => {
    const teamId = req.query.teamId;
    const q = teamId ? { teamId } : {};
    res.json(await Player.find(q).sort("fullName"));
});
app.get("/api/matches/:id/innings", async (req, res) => {
    const inns = await Innings.find({ matchId: req.params.id }).sort("createdAt").lean();
    res.json(inns.map(i => ({
        _id: String(i._id),
        battingTeamId: String(i.battingTeamId),
        bowlingTeamId: String(i.bowlingTeamId),
        runs: i.runs || 0,
        wickets: i.wickets || 0,
        legalBalls: i.legalBalls || 0,
        extras: i.extras || 0
    })));
});
/* Explicit chase info */
app.get("/api/matches/:id/chase-info", async (req, res) => {
    const matchId = req.params.id;
    const match = await Match.findById(matchId);
    if (!match)
        return res.status(HTTP.NOT_FOUND).json({ error: "match not found" });
    const inns = await Innings.find({ matchId }).sort("createdAt").lean();
    if (inns.length < 2)
        return res.json({ active: false });
    const first = inns[0];
    const second = inns[1];
    const state = await MatchState.findOne({ matchId });
    const target = (first.runs || 0) + 1;
    const runs = state?.runs ?? second.runs ?? 0;
    const ballsUsed = second.legalBalls || 0;
    const ballsLeft = Math.max(0, (match.maxOvers * 6) - ballsUsed);
    const need = Math.max(0, target - runs);
    res.json({
        active: true,
        target,
        runs,
        need,
        ballsLeft,
        battingTeamId: String(second.battingTeamId),
        bowlingTeamId: String(second.bowlingTeamId)
    });
});
/* Tournament standings (per group) + NRR */
app.get("/api/tournaments/:id/standings", async (req, res) => {
    const tournamentId = req.params.id;
    const groups = await Group.find({ tournamentId }).lean();
    const matches = await Match.find({ tournamentId }).lean();
    // Map team -> group
    const gTeams = await GroupTeam.find({ groupId: { $in: groups.map(g => g._id) } }).lean();
    const teamToGroup = new Map();
    gTeams.forEach(gt => teamToGroup.set(String(gt.teamId), String(gt.groupId)));
    const teams = await Team.find().lean();
    const teamName = new Map();
    teams.forEach(t => teamName.set(String(t._id), t.name));
    // Initialize tables
    const tables = {};
    for (const g of groups)
        tables[String(g._id)] = {};
    // Helper to ensure row exists
    const ensureRow = (groupId, teamId) => {
        const t = tables[groupId];
        if (!t[teamId]) {
            t[teamId] = {
                teamId,
                teamName: teamName.get(teamId) || "Team",
                played: 0, won: 0, lost: 0, tied: 0, noResult: 0, points: 0,
                runsFor: 0, ballsFaced: 0,
                runsAgainst: 0, ballsBowled: 0,
                nrr: 0
            };
        }
        return t[teamId];
    };
    for (const m of matches) {
        const inns = await Innings.find({ matchId: m._id }).sort("createdAt").lean();
        if (inns.length < 1)
            continue;
        const teamA = String(m.teamAId);
        const teamB = String(m.teamBId);
        const gA = teamToGroup.get(teamA);
        const gB = teamToGroup.get(teamB);
        if (!gA || !gB || gA !== gB)
            continue; // only count if both in same group
        const aRow = ensureRow(gA, teamA);
        const bRow = ensureRow(gB, teamB);
        // We assume two-innings max, each team once
        for (const inn of inns) {
            const batId = String(inn.battingTeamId);
            const bowlId = String(inn.bowlingTeamId);
            const batBalls = inn.legalBalls || 0;
            const bowlBalls = inn.legalBalls || 0;
            const batRow = ensureRow(teamToGroup.get(batId), batId);
            const bowlRow = ensureRow(teamToGroup.get(bowlId), bowlId);
            batRow.runsFor += inn.runs || 0;
            batRow.ballsFaced += batBalls;
            bowlRow.runsAgainst += inn.runs || 0;
            bowlRow.ballsBowled += bowlBalls;
        }
        // Results/points if finished
        const res = await MatchResult.findOne({ matchId: m._id }).lean();
        const played = inns.length >= 2 || m.status === "finished";
        if (played) {
            aRow.played += 1;
            bRow.played += 1;
            if (res?.isTie) {
                aRow.tied += 1;
                bRow.tied += 1;
                aRow.points += 1;
                bRow.points += 1;
            }
            else if (res?.isNoResult) {
                aRow.noResult += 1;
                bRow.noResult += 1;
                aRow.points += 1;
                bRow.points += 1;
            }
            else if (res?.winnerTeamId) {
                const w = String(res.winnerTeamId);
                if (w === teamA) {
                    aRow.won += 1;
                    aRow.points += 2;
                    bRow.lost += 1;
                }
                else if (w === teamB) {
                    bRow.won += 1;
                    bRow.points += 2;
                    aRow.lost += 1;
                }
            }
            else if (m.status === "finished") {
                // Fallback compute winner by totals
                const totals = await totalsByTeam(String(m._id));
                const a = totals.map[teamA] || 0;
                const b = totals.map[teamB] || 0;
                if (a === b) {
                    aRow.tied += 1;
                    bRow.tied += 1;
                    aRow.points += 1;
                    bRow.points += 1;
                }
                else if (a > b) {
                    aRow.won += 1;
                    aRow.points += 2;
                    bRow.lost += 1;
                }
                else {
                    bRow.won += 1;
                    bRow.points += 2;
                    aRow.lost += 1;
                }
            }
        }
    }
    // Compute NRR and sort inside groups
    const out = groups.map(g => {
        const rows = Object.values(tables[String(g._id)]).map((r) => {
            const oversFor = r.ballsFaced > 0 ? (r.ballsFaced / 6) : 0;
            const oversAg = r.ballsBowled > 0 ? (r.ballsBowled / 6) : 0;
            const forRR = oversFor > 0 ? (r.runsFor / oversFor) : 0;
            const agRR = oversAg > 0 ? (r.runsAgainst / oversAg) : 0;
            r.nrr = Number((forRR - agRR).toFixed(3));
            return r;
        }).sort((a, b) => {
            if (b.points !== a.points)
                return b.points - a.points;
            if (b.nrr !== a.nrr)
                return b.nrr - a.nrr;
            return b.runsFor - a.runsFor;
        });
        return { groupId: String(g._id), groupName: g.name, table: rows };
    });
    res.json({ groups: out });
});
/* ------------ Start / Resume (protected) ------------ */
app.post("/api/matches/:id/start", authRequired, async (req, res) => {
    const matchId = req.params.id;
    const { striker, nonStriker, bowler, strikerId, nonStrikerId, bowlerId, battingTeamId, bowlingTeamId, maxOvers } = req.body;
    const match = await Match.findById(matchId);
    if (!match)
        return res.status(HTTP.NOT_FOUND).json({ error: "match not found" });
    if (match.status === "finished") {
        return res.status(409).json({ error: "Match already finished" });
    }
    const ovs = Number(maxOvers ?? match.maxOvers ?? 6);
    match.maxOvers = ALLOWED_OVERS.has(ovs) ? ovs : 6;
    await match.save();
    let st = await MatchState.findOne({ matchId });
    let inn = null;
    if (!st) {
        inn = await Innings.create({ matchId, battingTeamId, bowlingTeamId });
        st = await MatchState.create({
            matchId, runs: 0, wickets: 0, balls: 0,
            striker, nonStriker, bowler: bowler ?? "",
            strikerId, nonStrikerId, bowlerId,
            lastEvent: "", currentInningsId: inn._id,
            nextBallFreeHit: false, waitingForNewBatter: false, waitingForNewBatterEnd: "striker",
            waitingForOpeners: false
        });
    }
    else if (match.status !== "live") {
        st.striker = striker ?? st.striker;
        st.nonStriker = nonStriker ?? st.nonStriker;
        st.bowler = bowler ?? st.bowler;
        st.strikerId = strikerId ?? st.strikerId;
        st.nonStrikerId = nonStrikerId ?? st.nonStrikerId;
        st.bowlerId = bowlerId ?? st.bowlerId;
        await st.save();
        inn = await Innings.findById(st.currentInningsId);
    }
    else {
        inn = await Innings.findById(st.currentInningsId);
    }
    match.status = "live";
    await match.save();
    io.to(ch(matchId)).emit("state:update", st);
    res.json({ match, state: st });
});
/* ------------ Bowler (protected) ------------ */
app.post("/api/matches/:id/set-bowler", authRequired, async (req, res) => {
    const matchId = req.params.id;
    const { bowlerId } = req.body;
    const match = await Match.findById(matchId);
    if (!match)
        return res.status(HTTP.NOT_FOUND).json({ error: "match not found" });
    if (match.status === "finished")
        return res.status(409).json({ error: "Match already finished" });
    const st = await MatchState.findOne({ matchId });
    const inn = st ? await Innings.findById(st.currentInningsId) : null;
    if (!st || !inn)
        return res.status(HTTP.NOT_FOUND).json({ error: "state/innings not found" });
    if (bowlerId) {
        const bowledBalls = await BallEvent.countDocuments({ matchId, inningsId: inn._id, bowlerId });
        const limitBalls = ballsFromOvers(maxOversPerBowler(match.maxOvers ?? 6));
        if (bowledBalls >= limitBalls) {
            return res.status(400).json({ error: "Bowler has reached the innings limit" });
        }
    }
    const bowler = bowlerId ? await Player.findById(bowlerId) : null;
    st.bowlerId = bowler?._id || undefined;
    st.bowler = bowler?.fullName ?? "";
    await st.save();
    io.to(ch(matchId)).emit("state:update", st);
    res.json(st);
});
/* ------------ New batter (protected) ------------ */
app.get("/api/matches/:id/new-batter/options", async (req, res) => {
    const st = await MatchState.findOne({ matchId: req.params.id });
    const inn = st ? await Innings.findById(st.currentInningsId) : null;
    if (!st || !inn)
        return res.status(HTTP.NOT_FOUND).json({ error: "state/innings not found" });
    if (!st.waitingForNewBatter) {
        return res.json({ waiting: false, end: null, battingTeamId: inn.battingTeamId, players: [] });
    }
    const eligible = await eligibleBatters(req.params.id, st, inn);
    res.json({
        waiting: true, end: st.waitingForNewBatterEnd, battingTeamId: String(inn.battingTeamId),
        players: eligible.map(p => ({ _id: String(p._id), fullName: p.fullName }))
    });
});
app.post("/api/matches/:id/new-batter", authRequired, async (req, res) => {
    const match = await Match.findById(req.params.id);
    if (!match)
        return res.status(HTTP.NOT_FOUND).json({ error: "match not found" });
    if (match.status === "finished")
        return res.status(409).json({ error: "Match already finished" });
    const st = await MatchState.findOne({ matchId: req.params.id });
    const inn = st ? await Innings.findById(st.currentInningsId) : null;
    if (!st || !inn)
        return res.status(HTTP.NOT_FOUND).json({ error: "state/innings not found" });
    if (!st.waitingForNewBatter)
        return res.status(400).json({ error: "Not expecting a new batter" });
    const { playerId, end } = req.body;
    const whichEnd = end || st.waitingForNewBatterEnd || "striker";
    const p = await Player.findById(playerId);
    if (!p)
        return res.status(HTTP.NOT_FOUND).json({ error: "player not found" });
    if (String(p.teamId) !== String(inn.battingTeamId)) {
        return res.status(400).json({ error: "Player is not from the batting team" });
    }
    if (String(st.strikerId) === String(p._id) || String(st.nonStrikerId) === String(p._id)) {
        return res.status(400).json({ error: "Player already on the field" });
    }
    if (whichEnd === "striker") {
        st.strikerId = p._id;
        st.striker = p.fullName;
    }
    else {
        st.nonStrikerId = p._id;
        st.nonStriker = p.fullName;
    }
    st.waitingForNewBatter = false;
    await st.save();
    io.to(ch(String(match._id))).emit("state:update", st);
    res.json(st);
});
/* ------------ Second-innings openers (protected apply; public read options) ------------ */
app.get("/api/matches/:id/openers/options", async (req, res) => {
    const st = await MatchState.findOne({ matchId: req.params.id });
    if (!st)
        return res.status(HTTP.NOT_FOUND).json({ error: "state not found" });
    const inn = await Innings.findById(st.currentInningsId);
    if (!inn)
        return res.status(HTTP.NOT_FOUND).json({ error: "innings not found" });
    if (!st.waitingForOpeners)
        return res.json({ waiting: false });
    const batPlayers = await Player.find({ teamId: inn.battingTeamId }).sort("fullName").lean();
    const bowlPlayers = await Player.find({ teamId: inn.bowlingTeamId }).sort("fullName").lean();
    res.json({
        waiting: true,
        battingTeamId: String(inn.battingTeamId),
        bowlingTeamId: String(inn.bowlingTeamId),
        batters: batPlayers.map(p => ({ _id: String(p._id), fullName: p.fullName })),
        bowlers: bowlPlayers.map(p => ({ _id: String(p._id), fullName: p.fullName }))
    });
});
app.post("/api/matches/:id/openers", authRequired, async (req, res) => {
    const match = await Match.findById(req.params.id);
    if (!match)
        return res.status(HTTP.NOT_FOUND).json({ error: "match not found" });
    if (match.status === "finished")
        return res.status(409).json({ error: "Match already finished" });
    const st = await MatchState.findOne({ matchId: req.params.id });
    const inn = st ? await Innings.findById(st.currentInningsId) : null;
    if (!st || !inn)
        return res.status(HTTP.NOT_FOUND).json({ error: "state/innings not found" });
    if (!st.waitingForOpeners)
        return res.status(400).json({ error: "Not waiting for openers" });
    const { strikerId, nonStrikerId, bowlerId } = req.body;
    if (!strikerId || !nonStrikerId || strikerId === nonStrikerId) {
        return res.status(400).json({ error: "Pick distinct striker & non-striker" });
    }
    const s = await Player.findById(strikerId);
    const ns = await Player.findById(nonStrikerId);
    if (!s || !ns)
        return res.status(HTTP.NOT_FOUND).json({ error: "player not found" });
    if (String(s.teamId) !== String(inn.battingTeamId) || String(ns.teamId) !== String(inn.battingTeamId)) {
        return res.status(400).json({ error: "Openers must be from batting team" });
    }
    st.strikerId = s._id;
    st.striker = s.fullName;
    st.nonStrikerId = ns._id;
    st.nonStriker = ns.fullName;
    if (bowlerId) {
        const b = await Player.findById(bowlerId);
        if (!b || String(b.teamId) !== String(inn.bowlingTeamId)) {
            return res.status(400).json({ error: "Bowler must be from bowling team" });
        }
        st.bowlerId = b._id;
        st.bowler = b.fullName;
    }
    else {
        st.bowlerId = undefined;
        st.bowler = "";
    }
    st.waitingForOpeners = false;
    await st.save();
    io.to(ch(String(match._id))).emit("state:update", st);
    res.json(st);
});
/* ------------ Innings progression ------------ */
async function maybeAdvanceInnings(matchId) {
    const st = await MatchState.findOne({ matchId });
    if (!st)
        return;
    const match = await Match.findById(matchId);
    if (!match)
        return;
    const inn = await Innings.findById(st.currentInningsId);
    if (!inn)
        return;
    const ballsLimit = (match.maxOvers ?? 6) * 6;
    const wicketsLimit = await wicketsAllOutThreshold(inn);
    const noBattersLeft = st.waitingForNewBatter && (await eligibleBatters(matchId, st, inn)).length === 0;
    const inningsEnded = inn.legalBalls >= ballsLimit || inn.wickets >= wicketsLimit || noBattersLeft;
    if (!inningsEnded)
        return;
    if (st.waitingForNewBatter)
        st.waitingForNewBatter = false;
    const count = await Innings.countDocuments({ matchId });
    if (count === 1) {
        // start 2nd innings
        const nextBat = inn.bowlingTeamId;
        const nextBowl = inn.battingTeamId;
        const newInn = await Innings.create({ matchId, battingTeamId: nextBat, bowlingTeamId: nextBowl });
        st.currentInningsId = newInn._id;
        st.runs = 0;
        st.wickets = 0;
        st.balls = 0;
        st.strikerId = undefined;
        st.striker = "";
        st.nonStrikerId = undefined;
        st.nonStriker = "";
        st.bowlerId = undefined;
        st.bowler = "";
        st.nextBallFreeHit = false;
        st.waitingForOpeners = true;
        const target = (inn.runs || 0) + 1;
        st.lastEvent = `Innings complete. Target ${target}. Waiting for second-innings openers.`;
        await st.save();
        io.to(ch(matchId)).emit("innings:changed", { inningsNo: 2, target });
        io.to(ch(matchId)).emit("state:update", st);
        return;
    }
    // count >= 2 → match over
    const { map } = await totalsByTeam(matchId);
    const a = map[String(match.teamAId)] || 0;
    const b = map[String(match.teamBId)] || 0;
    if (a === b)
        await finishMatchNow(match, null, true);
    else
        await finishMatchNow(match, a > b ? match.teamAId : match.teamBId, false);
}
/* ------------ Ball (protected) ------------ */
app.post("/api/matches/:id/ball", authRequired, async (req, res) => {
    const matchId = req.params.id;
    const match = await Match.findById(matchId);
    if (!match)
        return res.status(HTTP.NOT_FOUND).json({ error: "match not found" });
    if (match.status === "finished")
        return res.status(409).json({ error: "Match already finished" });
    const st = await MatchState.findOne({ matchId });
    if (!st)
        return res.status(HTTP.NOT_FOUND).json({ error: "state not found" });
    const inn = await Innings.findById(st.currentInningsId);
    if (!inn)
        return res.status(HTTP.NOT_FOUND).json({ error: "innings not found" });
    if (st.waitingForOpeners)
        return res.status(400).json({ error: "Pick second-innings openers first" });
    const { runs = 0, wicket = false, kind = "normal", note = "", strikerId = null, nonStrikerId = null, bowlerId = null, dismissalType = "", outEnd = "" } = req.body;
    if (strikerId)
        st.strikerId = strikerId;
    if (nonStrikerId)
        st.nonStrikerId = nonStrikerId;
    if (bowlerId)
        st.bowlerId = bowlerId;
    if (!st.strikerId)
        return res.status(400).json({ error: "strikerId missing" });
    if (!st.bowlerId)
        return res.status(400).json({ error: "bowlerId missing" });
    if (!st.striker)
        st.striker = (await Player.findById(st.strikerId))?.fullName ?? "";
    if (!st.nonStriker)
        st.nonStriker = st.nonStrikerId ? ((await Player.findById(st.nonStrikerId))?.fullName ?? "") : "";
    if (!st.bowler)
        st.bowler = (await Player.findById(st.bowlerId))?.fullName ?? "";
    const isLegal = !(kind === "wide" || kind === "no-ball");
    const penalty = (kind === "wide" || kind === "no-ball") ? 1 : 0;
    const batRuns = runs;
    // FREE-HIT: only run-out allowed
    let effWicket = wicket;
    const isRunout = /runout/i.test(dismissalType || "");
    if (st.nextBallFreeHit && effWicket && !isRunout)
        effWicket = false;
    await BallEvent.create({
        matchId, inningsId: inn._id, batterId: st.strikerId, bowlerId: st.bowlerId,
        runs: batRuns, wicket: effWicket, kind, ballsBefore: st.balls, note,
        dismissalType, outEnd: (isRunout && effWicket ? (outEnd || "striker") : "")
    });
    // Team runs
    const teamRuns = penalty +
        ((kind === "bye" || kind === "leg-bye") ? runs : 0) +
        ((kind === "normal" || kind === "no-ball") ? runs : 0);
    // Tally innings + state
    inn.runs += teamRuns;
    inn.wickets += (effWicket ? 1 : 0);
    inn.legalBalls += (isLegal ? 1 : 0);
    if (kind === "wide" || kind === "no-ball")
        inn.extras += penalty;
    if (kind === "bye" || kind === "leg-bye")
        inn.extras += runs;
    await inn.save();
    st.runs += teamRuns;
    st.wickets += (effWicket ? 1 : 0);
    st.balls += (isLegal ? 1 : 0);
    // Batting stats
    const faced = (kind !== "wide") ? 1 : 0;
    const batInc = {};
    if (kind === "normal" || kind === "no-ball") {
        batInc.runs = batRuns;
        if (batRuns === 4)
            batInc.fours = 1;
        if (batRuns === 6)
            batInc.sixes = 1;
    }
    if (faced)
        batInc.ballsFaced = 1;
    await PlayerStats.updateOne({ matchId, playerId: st.strikerId }, { $setOnInsert: { teamId: inn.battingTeamId }, $inc: batInc }, { upsert: true });
    // Bowling stats
    await PlayerStats.updateOne({ matchId, playerId: st.bowlerId }, {
        $setOnInsert: { teamId: inn.bowlingTeamId }, $inc: {
            ballsBowled: (isLegal ? 1 : 0),
            runsConceded: teamRuns,
            wickets: (effWicket ? 1 : 0)
        }
    }, { upsert: true });
    // Dismissals & wait-for-new-batter
    if (effWicket) {
        if (isRunout) {
            const which = (outEnd === "non-striker") ? "non-striker" : "striker";
            const outId = which === "striker" ? st.strikerId : st.nonStrikerId;
            if (outId)
                await PlayerStats.updateOne({ matchId, playerId: outId }, { $set: { isOut: true, howOut: "runout" } });
            st.waitingForNewBatter = true;
            st.waitingForNewBatterEnd = (outEnd === "non-striker" ? "non-striker" : "striker");
            if (outEnd === "non-striker") {
                st.nonStrikerId = undefined;
                st.nonStriker = "";
            }
            else {
                st.strikerId = undefined;
                st.striker = "";
            }
        }
        else {
            await PlayerStats.updateOne({ matchId, playerId: st.strikerId }, { $set: { isOut: true, howOut: dismissalType || kind } });
            st.waitingForNewBatter = true;
            st.waitingForNewBatterEnd = "striker";
            st.strikerId = undefined;
            st.striker = "";
        }
    }
    // Strike logic
    const swap = () => {
        const a = st.strikerId;
        st.strikerId = st.nonStrikerId;
        st.nonStrikerId = a;
        const an = st.striker;
        st.striker = st.nonStriker;
        st.nonStriker = an;
    };
    if (kind === "normal" && isLegal && (batRuns % 2 === 1))
        swap();
    if ((kind === "bye" || kind === "leg-bye") && isLegal && (runs % 2 === 1))
        swap();
    if (kind === "no-ball" && (batRuns % 2 === 1))
        swap();
    // Over end: swap ends and flip which end needs new batter if waiting
    if (isLegal && st.balls % 6 === 0) {
        swap();
        if (st.waitingForNewBatter) {
            st.waitingForNewBatterEnd = (st.waitingForNewBatterEnd === "striker") ? "non-striker" : "striker";
        }
        st.bowlerId = undefined;
        st.bowler = "";
        io.to(ch(matchId)).emit("over:complete", { over: Math.floor(inn.legalBalls / 6) });
    }
    st.nextBallFreeHit = (kind === "no-ball");
    st.lastEvent = effWicket
        ? `Wicket (${dismissalType || kind}${isRunout && outEnd ? `, ${outEnd} out` : ""})`
        : (kind === "normal" ? `${batRuns} run(s)`
            : kind === "wide" ? `Wide +1`
                : kind === "no-ball" ? (batRuns ? `No-ball +1 & ${batRuns}` : `No-ball +1`)
                    : `${kind} ${runs}`);
    await st.save();
    io.to(ch(matchId)).emit("state:update", st);
    // EARLY FINISH: stop the moment target is reached in 2nd innings
    const firstInn = await Innings.findOne({ matchId }).sort("createdAt").lean();
    if (firstInn && String(firstInn._id) !== String(inn._id)) {
        const target = (firstInn.runs || 0) + 1;
        if ((inn.runs || 0) >= target) {
            await finishMatchNow(match, inn.battingTeamId, false);
            return res.status(HTTP.CREATED).json({ ok: true });
        }
    }
    // If wicket fell and no eligible batter remains, end innings immediately
    if (st.waitingForNewBatter && (await eligibleBatters(matchId, st, inn)).length === 0) {
        st.waitingForNewBatter = false;
        await st.save();
        await maybeAdvanceInnings(matchId);
        return res.status(HTTP.CREATED).json({ ok: true });
    }
    await maybeAdvanceInnings(matchId);
    res.status(HTTP.CREATED).json({ ok: true });
});
/* ------------ Totals / Scorecard / Overall ------------ */
app.get("/api/matches/:id/totals", async (req, res) => {
    const { map } = await totalsByTeam(req.params.id);
    res.json({ totals: map });
});
app.get("/api/matches/:id/scorecard", async (req, res) => {
    const matchId = req.params.id;
    const stats = await PlayerStats.find({ matchId }).lean();
    const st = await MatchState.findOne({ matchId });
    const needed = new Set();
    if (st?.strikerId)
        needed.add(String(st.strikerId));
    if (st?.nonStrikerId)
        needed.add(String(st.nonStrikerId));
    if (st?.bowlerId)
        needed.add(String(st.bowlerId));
    const ids = Array.from(new Set([...stats.map(s => String(s.playerId)), ...needed]));
    if (!ids.length)
        return res.json({});
    const players = await Player.find({ _id: { $in: ids } }).lean();
    const pMap = new Map();
    players.forEach(p => pMap.set(String(p._id), p));
    const merged = [...stats];
    for (const pid of needed) {
        if (!merged.find(s => String(s.playerId) === pid)) {
            const p = pMap.get(pid);
            if (!p)
                continue;
            merged.push({
                matchId, playerId: p._id, teamId: p.teamId,
                runs: 0, ballsFaced: 0, fours: 0, sixes: 0,
                ballsBowled: 0, runsConceded: 0, wickets: 0
            });
        }
    }
    const byTeam = {};
    const b2o = (b) => `${Math.floor((b || 0) / 6)}.${(b || 0) % 6}`;
    for (const s of merged) {
        const p = pMap.get(String(s.playerId));
        if (!p)
            continue;
        const tid = String(p.teamId);
        (byTeam[tid] ??= { batting: [], bowling: [] });
        byTeam[tid].batting.push({
            playerId: String(s.playerId), name: p.fullName,
            runs: s.runs || 0, balls: s.ballsFaced || 0,
            fours: s.fours || 0, sixes: s.sixes || 0,
            isOut: !!s.isOut, howOut: s.howOut || ""
        });
        const showBowlerRow = (s.ballsBowled || 0) > 0 || (s.wickets || 0) > 0 || (s.runsConceded || 0) > 0 || String(s.playerId) === String(st?.bowlerId);
        if (showBowlerRow) {
            byTeam[tid].bowling.push({
                playerId: String(s.playerId), name: p.fullName,
                overs: b2o(s.ballsBowled || 0),
                runsConceded: s.runsConceded || 0,
                wickets: s.wickets || 0
            });
        }
    }
    res.json(byTeam);
});
app.get("/api/stats/players", async (req, res) => {
    const { tournamentId, groupId, limit = 100 } = req.query;
    const matchFilter = {};
    if (tournamentId)
        matchFilter.tournamentId = tournamentId;
    if (groupId)
        matchFilter.groupId = groupId;
    let matchIds = [];
    if (Object.keys(matchFilter).length) {
        matchIds = (await Match.find(matchFilter).select("_id")).map(m => m._id);
    }
    const psMatch = {};
    if (matchIds.length)
        psMatch.matchId = { $in: matchIds };
    const rows = await PlayerStats.aggregate([
        { $match: psMatch },
        {
            $group: {
                _id: "$playerId",
                teamId: { $first: "$teamId" },
                runs: { $sum: "$runs" },
                ballsFaced: { $sum: "$ballsFaced" },
                fours: { $sum: "$fours" },
                sixes: { $sum: "$sixes" },
                ballsBowled: { $sum: "$ballsBowled" },
                runsConceded: { $sum: "$runsConceded" },
                wickets: { $sum: "$wickets" }
            }
        },
        { $lookup: { from: "players", localField: "_id", foreignField: "_id", as: "player" } },
        { $unwind: "$player" },
        { $lookup: { from: "teams", localField: "teamId", foreignField: "_id", as: "team" } },
        { $unwind: "$team" },
        {
            $addFields: {
                strikeRate: { $cond: [{ $gt: ["$ballsFaced", 0] }, { $multiply: [{ $divide: ["$runs", "$ballsFaced"] }, 100] }, 0] },
                economy: { $cond: [{ $gt: ["$ballsBowled", 0] }, { $divide: ["$runsConceded", { $divide: ["$ballsBowled", 6] }] }, 0] }
            }
        },
        { $sort: { runs: -1, wickets: -1, strikeRate: -1 } },
        { $limit: Number(limit) }
    ]);
    res.json(rows.map(r => ({
        playerId: r._id,
        playerName: r.player.fullName,
        teamId: r.teamId,
        teamName: r.team.name,
        runs: r.runs || 0,
        ballsFaced: r.ballsFaced || 0,
        fours: r.fours || 0,
        sixes: r.sixes || 0,
        strikeRate: Number((r.strikeRate || 0).toFixed(1)),
        wickets: r.wickets || 0,
        ballsBowled: r.ballsBowled || 0,
        runsConceded: r.runsConceded || 0,
        economy: Number((r.economy || 0).toFixed(2))
    })));
});
/* ------------ Get match + state ------------ */
app.get("/api/matches/:id", async (req, res) => {
    const match = await Match.findById(req.params.id);
    const state = await MatchState.findOne({ matchId: match?._id });
    res.json({ match, state });
});
/* ------------ sockets ------------ */
io.on("connection", (socket) => {
    socket.on("match:join", (matchId) => {
        socket.join(ch(matchId));
        const count = (io.sockets.adapter.rooms.get(ch(matchId))?.size ?? 0);
        io.to(ch(matchId)).emit("presence", { count });
    });
});
http.listen(PORT, () => console.log(`API listening on ${PORT}`));
