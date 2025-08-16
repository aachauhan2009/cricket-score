import React, { useEffect, useMemo, useState } from "react";
import { BrowserRouter, Routes, Route, Link, useNavigate, useParams, NavLink } from "react-router-dom";
import { io } from "socket.io-client";
import "./styles.css";

const API = import.meta.env.VITE_API_BASE || "http://localhost:4000";
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || API;

/* ----------------- Types ----------------- */
type Team = { _id: string; name: string; shortName?: string };
type Group = { _id: string; tournamentId: string; name: string };
type Tournament = { _id: string; name: string };
type Match = { _id: string; title: string; teamAId: string; teamBId: string; maxOvers: number; status: "scheduled" | "live" | "finished"; groupId?: string };
type State = {
  matchId: string; currentInningsId?: string;
  runs: number; wickets: number; balls: number;
  striker?: string; nonStriker?: string; bowler?: string; lastEvent?: string;
  strikerId?: string; nonStrikerId?: string; bowlerId?: string;
  nextBallFreeHit?: boolean;
  waitingForNewBatter?: boolean;
  waitingForNewBatterEnd?: "striker" | "non-striker";
  waitingForOpeners?: boolean;
};
type Player = { _id: string; teamId: string; fullName: string };
type Inn = { _id: string; battingTeamId: string; bowlingTeamId: string; runs: number; wickets: number; legalBalls: number; extras?: number };
type Chase = { active: boolean; target: number; need: number; ballsLeft: number; runs: number; battingTeamId: string; bowlingTeamId: string };

/* ----------------- Utils ----------------- */
const overStr = (balls: number) => `${Math.floor(balls / 6)}.${balls % 6}`;
const cls = (...xs: (string | false | undefined)[]) => xs.filter(Boolean).join(" ");
const fetchJSON = async (url: string, init?: RequestInit) => {
  const res = await fetch(url, { credentials: "include", ...init });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
};

/* ----------------- Shared Scoreboard (read-only view) ----------------- */
function ScoreboardView({
  match, state, innings, teamName, chase, viewerCount
}: {
  match: Match; state: State; innings: Inn[]; teamName: Record<string, string>; chase: Chase | null; viewerCount: number;
}) {
  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className="badge">{match.title}</span>
          <span className="sub">{viewerCount} watching</span>
        </div>
        <div className="sub">Max overs: <b>{match.maxOvers}</b></div>
      </div>

      {/* 1st-innings summary line */}
      {innings[0] && (
        <div className="sub" style={{ marginTop: 8 }}>
          1st inns — <b>{teamName[innings[0].battingTeamId] || "Team"}</b>: <b>{innings[0].runs}/{innings[0].wickets}</b> in {overStr(innings[0].legalBalls)} ov
        </div>
      )}

      {/* Chase info */}
      {chase?.active && (
        <div className="sub" style={{ marginTop: 6 }}>
          Target <b>{chase.target}</b> • Need <b>{chase.need}</b> off <b>{chase.ballsLeft}</b> ball(s)
        </div>
      )}

      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr", marginTop: 10 }}>
        <div>
          <div className="sub">Current innings</div>
          <div className="stat"><b>{state.runs}/{state.wickets}</b> in {overStr(state.balls)} ov</div>
          <div className="sub">Striker: {state.striker || "—"} • Non-striker: {state.nonStriker || "—"}</div>
          <div className="sub">Bowler: {state.bowler || "—"} {state.nextBallFreeHit && <span className="badge" style={{ marginLeft: 8 }}>FREE-HIT next</span>}</div>
          {state.lastEvent && <div className="sub" style={{ marginTop: 6 }}>Last: {state.lastEvent}</div>}
        </div>
        <div>
          <div className="sub">Match totals</div>
          <div style={{ display: "grid", gap: 6 }}>
            <div><b>{teamName[match.teamAId] || "Team A"}:</b> {(window as any).__totals?.[match.teamAId] ?? 0}</div>
            <div><b>{teamName[match.teamBId] || "Team B"}:</b> {(window as any).__totals?.[match.teamBId] ?? 0}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ----------------- Hooks used by viewer & admin ----------------- */
function useMatchLive(matchId: string, viewerOnly: boolean) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamName, setTeamName] = useState<Record<string, string>>({});
  const [match, setMatch] = useState<Match | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [viewerCount, setViewerCount] = useState(1);
  const [innings, setInnings] = useState<Inn[]>([]);
  const [chase, setChase] = useState<Chase | null>(null);
  const [finished, setFinished] = useState(false);
  const [resultText, setResultText] = useState("");
  const socket = useMemo(() => io(SOCKET_URL, { withCredentials: true }), []);

  useEffect(() => () => socket.disconnect(), [socket]);

  const refreshInnings = async () => match && setInnings(await fetchJSON(`${API}/api/matches/${match._id}/innings`));
  const refreshChase = async () => match && setChase(await fetchJSON(`${API}/api/matches/${match._id}/chase-info`).catch(() => null));
  const refreshTotals = async () => {
    if (!match) return;
    const { totals } = await fetchJSON(`${API}/api/matches/${match._id}/totals`);
    (window as any).__totals = totals || {};
  };

  useEffect(() => {
    (async () => {
      const ts: Team[] = await fetchJSON(`${API}/api/teams`);
      setTeams(ts); const m: Record<string, string> = {}; ts.forEach(t => m[t._id] = t.name); setTeamName(m);

      const data = await fetchJSON(`${API}/api/matches/${matchId}`);
      if (data?.match) {
        setMatch(data.match); setState(data.state);
        socket.emit("match:join", data.match._id);
        socket.on("presence", ({ count }) => setViewerCount(count));
        socket.on("innings:changed", async () => { await refreshInnings(); await refreshChase(); await refreshTotals(); });
        socket.on("state:update", async (st: State) => { setState(st); await refreshInnings(); await refreshChase(); await refreshTotals(); });
        socket.on("match:finished", async (payload: any) => {
          setFinished(true);
          await refreshInnings(); await refreshChase(); await refreshTotals();
          const winner = payload.isTie ? "Match tied" : `${m[payload.winnerTeamId] || "Winner"} won`;
          setResultText(winner);
        });
        await refreshInnings(); await refreshChase(); await refreshTotals();
        if (data.match.status === "finished") {
          setFinished(true);
          const totals: Record<string, number> = (await fetchJSON(`${API}/api/matches/${matchId}/totals`)).totals || {};
          const totalA = totals[data.match.teamAId] || 0;
          const totalB = totals[data.match.teamBId] || 0;
          setResultText(totalA === totalB ? "Match tied" : `${(m as any)[totalA > totalB ? data.match.teamAId : data.match.teamBId] || "Winner"} won`);
        }
      }
    })();
  }, [matchId]);

  return { teams, teamName, match, state, viewerCount, innings, chase, finished, resultText, socket, refreshChase };
}

/* ----------------- Public: Live viewer list ----------------- */
function ViewerList() {
  const [liveMatches, setLiveMatches] = useState<Match[]>([]);
  useEffect(() => { fetchJSON(`${API}/api/matches?status=live`).then(setLiveMatches).catch(() => setLiveMatches([])); }, []);
  return (
    <div className="card">
      <div className="h1">Watch Live</div>
      {!liveMatches.length && <div className="sub">No matches live right now.</div>}
      {!!liveMatches.length && (
        <div style={{ display: "grid", gap: 8 }}>
          {liveMatches.map(m => (
            <div key={m._id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>{m.title} <span className="badge" style={{ marginLeft: 8 }}>Live</span></div>
              <Link to={`/viewer/${m._id}`} className="btn">Watch</Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ----------------- Public: Viewer page ----------------- */
function ViewerPage() {
  const { matchId = "" } = useParams();
  const { teamName, match, state, innings, chase, viewerCount, finished, resultText } = useMatchLive(matchId, true);

  if (!match || !state) return <div className="card"><div className="sub">Loading…</div></div>;
  return (
    <>
      {finished && (
        <div className="card" style={{ borderColor: "#2e7d32" }}>
          <div className="h1">Result</div>
          <div className="stat">{resultText || "Match finished"}</div>
        </div>
      )}
      <ScoreboardView match={match} state={state} innings={innings} teamName={teamName} chase={chase} viewerCount={viewerCount} />
    </>
  );
}

/* ----------------- Admin: Login ----------------- */
function AdminLogin() {
  const nav = useNavigate();
  const [username, setU] = useState("");
  const [password, setP] = useState("");
  const [err, setErr] = useState("");

  const submit = async () => {
    try {
      await fetchJSON(`${API}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      });
      nav("/admin");
    } catch (e: any) {
      setErr(e.message || "Login failed");
    }
  };

  return (
    <div className="card">
      <div className="h1">Admin Login</div>
      <div className="row row-2" style={{ marginTop: 10 }}>
        <div>
          <label>Username</label>
          <input value={username} onChange={e => setU(e.target.value)} placeholder="admin" />
        </div>
        <div>
          <label>Password</label>
          <input type="password" value={password} onChange={e => setP(e.target.value)} placeholder="••••••••" />
        </div>
      </div>
      {err && <div className="sub" style={{ color: "#ff9f9f", marginTop: 6 }}>{err}</div>}
      <button className="btn-accent" style={{ marginTop: 10 }} onClick={submit}>Login</button>
    </div>
  );
}

/* ----------------- Admin: Start/Resume + Scoring ----------------- */
function StartMatch({ onStarted }: { onStarted: (m: Match, s: State) => void }) {
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);

  const [tId, setTId] = useState<string>("");
  const [gId, setGId] = useState<string>("");
  const [mId, setMId] = useState<string>("");

  const [playersA, setPlayersA] = useState<Player[]>([]);
  const [playersB, setPlayersB] = useState<Player[]>([]);
  const [battingTeamId, setBattingTeamId] = useState<string>("");
  const [bowlingTeamId, setBowlingTeamId] = useState<string>("");
  const [strikerId, setStrikerId] = useState<string>("");
  const [nonStrikerId, setNonStrikerId] = useState<string>("");
  const [bowlerId, setBowlerId] = useState<string>("");
  const [overs, setOvers] = useState<number>(6);

  const selectedMatch = useMemo<Match | null>(() => matches.find(m => m._id === mId) || null, [matches, mId]);

  useEffect(() => { fetchJSON(`${API}/api/tournaments`).then(setTournaments); fetchJSON(`${API}/api/teams`).then(setTeams); }, []);
  useEffect(() => { if (!tId) return; fetchJSON(`${API}/api/groups?tournamentId=${tId}`).then(setGroups); setGId(""); setMatches([]); setMId(""); }, [tId]);
  useEffect(() => { if (!gId) return; fetchJSON(`${API}/api/matches?groupId=${gId}`).then(setMatches); setMId(""); }, [gId]);

  const teamA = teams.find(t => t._id === selectedMatch?.teamAId);
  const teamB = teams.find(t => t._id === selectedMatch?.teamBId);

  useEffect(() => {
    const load = async () => {
      if (!selectedMatch) { setPlayersA([]); setPlayersB([]); return; }
      const [pa, pb] = await Promise.all([
        fetchJSON(`${API}/api/players?teamId=${selectedMatch.teamAId}`),
        fetchJSON(`${API}/api/players?teamId=${selectedMatch.teamBId}`)
      ]);
      setPlayersA(pa); setPlayersB(pb);
      setBattingTeamId(selectedMatch.teamAId);
      setBowlingTeamId(selectedMatch.teamBId);
      setStrikerId(pa[0]?._id || ""); setNonStrikerId(pa[1]?._id || "");
      setBowlerId(pb[0]?._id || "");
      setOvers(selectedMatch.maxOvers ?? 6);
    };
    load();
  }, [selectedMatch]);

  useEffect(() => {
    if (!selectedMatch || !battingTeamId) return;
    const newBowl = battingTeamId === selectedMatch.teamAId ? selectedMatch.teamBId : selectedMatch.teamAId;
    setBowlingTeamId(newBowl);
    const batList = battingTeamId === selectedMatch.teamAId ? playersA : playersB;
    const bowlList = battingTeamId === selectedMatch.teamAId ? playersB : playersA;
    setStrikerId(batList[0]?._id || ""); setNonStrikerId(batList[1]?._id || "");
    setBowlerId(bowlList[0]?._id || "");
  }, [battingTeamId]);

  const start = async () => {
    if (!selectedMatch) return alert("Pick a match");
    const resMe = await fetchJSON(`${API}/api/auth/me`).catch(() => ({ isAdmin: false }));
    if (!resMe.isAdmin) return alert("Login required (Admin)");
    if (selectedMatch.status === "live") {
      const data = await fetchJSON(`${API}/api/matches/${selectedMatch._id}`);
      if (!data?.match || !data?.state) return alert("Failed to resume");
      onStarted(data.match, data.state);
      return;
    }
    if (!battingTeamId || !bowlingTeamId || battingTeamId === bowlingTeamId) return alert("Choose batting & bowling");
    if (!strikerId || !nonStrikerId || strikerId === nonStrikerId) return alert("Pick distinct striker/non-striker");
    if (!bowlerId) return alert("Pick a bowler");
    if (![6, 8, 10, 20].includes(Number(overs))) return alert("Select valid overs");

    const all = [...playersA, ...playersB];
    const sName = all.find(p => p._id === strikerId)?.fullName || "";
    const nsName = all.find(p => p._id === nonStrikerId)?.fullName || "";
    const bName = all.find(p => p._id === bowlerId)?.fullName || "";

    const data = await fetchJSON(`${API}/api/matches/${selectedMatch._id}/start`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        striker: sName, nonStriker: nsName, bowler: bName,
        strikerId, nonStrikerId, bowlerId,
        battingTeamId, bowlingTeamId,
        maxOvers: Number(overs)
      })
    });
    onStarted(data.match, data.state);
  };

  const batList = battingTeamId === selectedMatch?.teamAId ? playersA : playersB;
  const bowlList = battingTeamId === selectedMatch?.teamAId ? playersB : playersA;

  return (
    <div className="card">
      <div className="h1">Start / Resume Match</div>
      <div className="row row-3">
        <div>
          <label>Tournament</label>
          <select value={tId} onChange={e => setTId(e.target.value)}>
            <option value="">Select tournament</option>
            {tournaments.map(t => <option key={t._id} value={t._id}>{t.name}</option>)}
          </select>
        </div>
        <div>
          <label>Group</label>
          <select value={gId} onChange={e => setGId(e.target.value)} disabled={!tId}>
            <option value="">Select group</option>
            {groups.map(g => <option key={g._id} value={g._id}>{g.name}</option>)}
          </select>
        </div>
        <div>
          <label>Match</label>
          <select value={mId} onChange={e => setMId(e.target.value)} disabled={!gId}>
            <option value="">Select match</option>
            {matches.map(m => <option key={m._id} value={m._id}>{m.title} ({m.status})</option>)}
          </select>
        </div>
      </div>

      {selectedMatch && selectedMatch.status !== "live" && (
        <>
          <div style={{ marginTop: 10 }}>
            <span className="badge">Who bats first?</span>
            <div style={{ display: "flex", gap: 14, marginTop: 8 }}>
              <label><input type="radio" checked={battingTeamId === selectedMatch.teamAId} onChange={() => setBattingTeamId(selectedMatch.teamAId)} /> {teamA?.name}</label>
              <label><input type="radio" checked={battingTeamId === selectedMatch.teamBId} onChange={() => setBattingTeamId(selectedMatch.teamBId)} /> {teamB?.name}</label>
            </div>
          </div>

          <div className="row row-3" style={{ marginTop: 10 }}>
            <div>
              <label>Striker</label>
              <select value={strikerId} onChange={e => setStrikerId(e.target.value)}>
                <option value="" disabled>Pick striker</option>
                {batList.map(p => <option key={p._id} value={p._id}>{p.fullName}</option>)}
              </select>
            </div>
            <div>
              <label>Non-striker</label>
              <select value={nonStrikerId} onChange={e => setNonStrikerId(e.target.value)}>
                <option value="" disabled>Pick non-striker</option>
                {batList.map(p => <option key={p._id} value={p._id}>{p.fullName}</option>)}
              </select>
            </div>
            <div>
              <label>Bowler (first over)</label>
              <select value={bowlerId} onChange={e => setBowlerId(e.target.value)}>
                <option value="" disabled>Pick bowler</option>
                {bowlList.map(p => <option key={p._id} value={p._id}>{p.fullName}</option>)}
              </select>
            </div>
          </div>

          <div className="row row-3" style={{ marginTop: 10 }}>
            <div>
              <label>Max overs</label>
              <select value={String(overs)} onChange={e => setOvers(Number(e.target.value))}>
                {[6, 8, 10, 20].map(o => <option key={o} value={o}>{o} overs</option>)}
              </select>
            </div>
          </div>
        </>
      )}

      {selectedMatch && (
        <button style={{ marginTop: 12 }} className="btn-accent" onClick={start}>
          {selectedMatch.status === "live" ? "Resume" : "Start"}
        </button>
      )}
    </div>
  );
}

/* ----------------- Admin: Live scoring page ----------------- */
function AdminPage() {
  const nav = useNavigate();
  const [isAdmin, setIsAdmin] = useState(false);
  const [match, setMatch] = useState<Match | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [playersByTeam, setPlayersByTeam] = useState<Record<string, Player[]>>({});
  const [teamName, setTeamName] = useState<Record<string, string>>({});
  const [innings, setInnings] = useState<Inn[]>([]);
  const [chase, setChase] = useState<Chase | null>(null);
  const [viewerCount, setViewerCount] = useState(1);
  const [finished, setFinished] = useState(false);
  const [resultText, setResultText] = useState("");
  const [needNewBatter, setNeedNewBatter] = useState(false);
  const [availableBatters, setAvailableBatters] = useState<Player[]>([]);
  const [newBatterId, setNewBatterId] = useState("");
  const [needOpeners, setNeedOpeners] = useState(false);
  const [openBatters, setOpenBatters] = useState<Player[]>([]);
  const [openBowlers, setOpenBowlers] = useState<Player[]>([]);
  const [openStrikerId, setOpenStrikerId] = useState("");
  const [openNonStrikerId, setOpenNonStrikerId] = useState("");
  const [openBowlerId, setOpenBowlerId] = useState("");
  const [showWicket, setShowWicket] = useState(false);
  const [dismissalType, setDismissalType] = useState("caught");
  const [outEnd, setOutEnd] = useState<"striker" | "non-striker">("striker");

  const socket = useMemo(() => io(SOCKET_URL, { withCredentials: true }), []);
  useEffect(() => () => socket.disconnect(), [socket]);

  // auth gate
  useEffect(() => {
    fetchJSON(`${API}/api/auth/me`).then(r => {
      if (!r.isAdmin) nav("/admin/login");
      setIsAdmin(!!r.isAdmin);
    }).catch(() => nav("/admin/login"));
  }, []);

  const refreshInnings = async () => match && setInnings(await fetchJSON(`${API}/api/matches/${match._id}/innings`));
  const refreshChase = async () => match && setChase(await fetchJSON(`${API}/api/matches/${match._id}/chase-info`).catch(() => null));
  const refreshTotals = async () => {
    if (!match) return;
    const { totals } = await fetchJSON(`${API}/api/matches/${match._id}/totals`);
    (window as any).__totals = totals || {};
  };

  const onStarted = async (m: Match, s: State) => {
    // Reset view state
    setMatch(m);
    setState(s);
    setFinished(false);
    setResultText("");

    // Load players and team names
    const [pa, pb, teams] = await Promise.all([
      fetchJSON(`${API}/api/players?teamId=${m.teamAId}`),
      fetchJSON(`${API}/api/players?teamId=${m.teamBId}`),
      fetchJSON(`${API}/api/teams`),
    ]);
    setPlayersByTeam({ [m.teamAId]: pa, [m.teamBId]: pb });
    const mNames: Record<string, string> = {};
    (teams as Team[]).forEach((t) => (mNames[t._id] = t.name));
    setTeamName(mNames);

    // Join live room and (re)bind socket handlers safely
    socket.emit("match:join", m._id);
    socket.off("presence");
    socket.off("innings:changed");
    socket.off("state:update");
    socket.off("match:finished");

    socket.on("presence", ({ count }) => setViewerCount(count));

    socket.on("innings:changed", async () => {
      await refreshInnings();
      await refreshChase();
      await refreshTotals();
    });

    socket.on("state:update", async (st: State) => {
      setState(st);
      await refreshInnings();
      await refreshChase();
      await refreshTotals();

      // ——— New batter flow (live) ———
      if (st.waitingForNewBatter) {
        try {
          const opts = await fetchJSON(`${API}/api/matches/${m._id}/new-batter/options`);
          const list: Player[] = (opts.players || []).map((p: any) => ({
            _id: p._id,
            fullName: p.fullName,
            teamId: opts.battingTeamId,
          }));
          if (list.length) {
            setAvailableBatters(list);
            setNewBatterId(list[0]._id || "");
            setNeedNewBatter(true);
          } else {
            setNeedNewBatter(false);
          }
        } catch {
          /* ignore */
        }
      } else {
        setNeedNewBatter(false);
      }

      // ——— Second-innings openers (live) ———
      if ((st as any).waitingForOpeners) {
        try {
          const opts = await fetchJSON(`${API}/api/matches/${m._id}/openers/options`);
          if (opts.waiting) {
            const bats: Player[] = (opts.batters || []).map((p: any) => ({
              _id: p._id,
              fullName: p.fullName,
              teamId: opts.battingTeamId,
            }));
            const bowls: Player[] = (opts.bowlers || []).map((p: any) => ({
              _id: p._id,
              fullName: p.fullName,
              teamId: opts.bowlingTeamId,
            }));
            setOpenBatters(bats);
            setOpenBowlers(bowls);
            setOpenStrikerId(bats[0]?._id || "");
            setOpenNonStrikerId(bats[1]?._id || "");
            setOpenBowlerId(bowls[0]?._id || "");
            setNeedOpeners(true);
          } else {
            setNeedOpeners(false);
          }
        } catch {
          /* ignore */
        }
      } else {
        setNeedOpeners(false);
      }
    });

    socket.on("match:finished", async (payload: any) => {
      setFinished(true);
      await refreshInnings();
      await refreshChase();
      await refreshTotals();
      setResultText(payload.isTie ? "Match tied" : `${(teamName[payload.winnerTeamId] || "Winner")} won`);
    });

    // Initial refresh
    await refreshInnings();
    await refreshChase();
    await refreshTotals();

    // 🔧 Immediate UI for pending flows on RESUME (no wait for socket events)
    if (s.waitingForNewBatter) {
      try {
        const opts = await fetchJSON(`${API}/api/matches/${m._id}/new-batter/options`);
        const list: Player[] = (opts.players || []).map((p: any) => ({
          _id: p._id,
          fullName: p.fullName,
          teamId: opts.battingTeamId,
        }));
        if (list.length) {
          setAvailableBatters(list);
          setNewBatterId(list[0]._id || "");
          setNeedNewBatter(true);
        }
      } catch {
        /* ignore */
      }
    }

    if ((s as any).waitingForOpeners) {
      try {
        const opts = await fetchJSON(`${API}/api/matches/${m._id}/openers/options`);
        if (opts.waiting) {
          const bats: Player[] = (opts.batters || []).map((p: any) => ({
            _id: p._id,
            fullName: p.fullName,
            teamId: opts.battingTeamId,
          }));
          const bowls: Player[] = (opts.bowlers || []).map((p: any) => ({
            _id: p._id,
            fullName: p.fullName,
            teamId: opts.bowlingTeamId,
          }));
          setOpenBatters(bats);
          setOpenBowlers(bowls);
          setOpenStrikerId(bats[0]?._id || "");
          setOpenNonStrikerId(bats[1]?._id || "");
          setOpenBowlerId(bowls[0]?._id || "");
          setNeedOpeners(true);
        }
      } catch {
        /* ignore */
      }
    }
  };


  const ensureBowler = () => !!state?.bowlerId;
  const setBowler = async (bowlerId: string) => {
    if (!match) return;
    await fetchJSON(`${API}/api/matches/${match._id}/set-bowler`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bowlerId })
    });
  };
  const sendBall = async (
    payload: { runs: number; kind: "normal" | "bye" | "leg-bye" | "wide" | "no-ball"; wicket?: boolean },
    dismissal?: string,
    runoutEnd?: "striker" | "non-striker"
  ) => {
    if (!match || !state || finished) return;
    if ((state as any).waitingForOpeners) return alert("Pick second-innings openers first.");
    if (state.waitingForNewBatter) return alert("Pick the new batter first.");
    if (!ensureBowler()) return alert("Pick a bowler to start/continue the over.");
    await fetchJSON(`${API}/api/matches/${match._id}/ball`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runs: payload.runs, kind: payload.kind, wicket: !!payload.wicket,
        strikerId: state.strikerId, nonStrikerId: state.nonStrikerId, bowlerId: state.bowlerId,
        dismissalType: dismissal, outEnd: runoutEnd
      })
    }).catch(async (e) => {
      if (String(e.message || "").includes("409")) {
        setFinished(true); setResultText("Match finished");
      } else { alert(e.message || "Unable to record ball"); }
    });
    await refreshChase();
  };
  const confirmNewBatter = async () => {
    if (!match || !state || !newBatterId) { setNeedNewBatter(false); return; }
    await fetchJSON(`${API}/api/matches/${match._id}/new-batter`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId: newBatterId, end: state.waitingForNewBatterEnd || "striker" })
    });
    setNeedNewBatter(false);
  };
  const confirmOpeners = async () => {
    if (!match) return;
    if (!openStrikerId || !openNonStrikerId || openStrikerId === openNonStrikerId) {
      alert("Pick distinct striker and non-striker"); return;
    }
    await fetchJSON(`${API}/api/matches/${match._id}/openers`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strikerId: openStrikerId, nonStrikerId: openNonStrikerId, bowlerId: openBowlerId || undefined })
    });
    setNeedOpeners(false);
    await refreshChase();
  };

  // UI
  return (
    <>
      <div className="card" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
        <div className="h1">Admin</div>
        <div style={{ display: "flex", gap: 8 }}>
          <Link to="/viewer" className="btn">Open Viewer</Link>
          <Link to="/tournaments" className="btn">Tournaments</Link>
          <button className="btn" onClick={async () => { await fetchJSON(`${API}/api/auth/logout`, { method: "POST" }); window.location.href = "/admin/login"; }}>Logout</button>
        </div>
      </div>

      {!match && <StartMatch onStarted={onStarted} />}

      {match && state && (
        <>
          {finished && (
            <div className="card" style={{ borderColor: "#2e7d32" }}>
              <div className="h1">Result</div>
              <div className="stat">{resultText || "Match finished"}</div>
            </div>
          )}

          {/* Read-only scoreboard */}
          <ScoreboardView match={match} state={state} innings={innings} teamName={teamName} chase={chase} viewerCount={viewerCount} />

          {/* Bowler select */}
          <div className="card">
            <div className="h1">Bowler</div>
            <div className="row row-2">
              <div>
                <label>Choose bowler</label>
                <select value={state.bowlerId || ""} onChange={e => setBowler(e.target.value)} disabled={(state as any).waitingForOpeners || finished}>
                  <option value="">Select bowler</option>
                  {(() => {
                    const all = (playersByTeam[match.teamAId] || []).concat(playersByTeam[match.teamBId] || []);
                    const striker = all.find(p => p._id === state.strikerId);
                    const battingTeamId = striker?.teamId;
                    const bowlingTeamId = battingTeamId === match?.teamAId ? match?.teamBId : match?.teamAId;
                    return (playersByTeam[bowlingTeamId || ""] || []).map(p => <option key={p._id} value={p._id}>{p.fullName}</option>);
                  })()}
                </select>
              </div>
            </div>
            {!state.bowlerId && !(state as any).waitingForOpeners && !finished && <div className="sub" style={{ marginTop: 6 }}>Pick a bowler to begin/continue the over.</div>}
          </div>

          {/* Second-innings openers */}
          {needOpeners && (
            <div className="card">
              <div className="h1">Second Innings • Pick Openers</div>
              <div className="row row-3">
                <div>
                  <label>Striker</label>
                  <select value={openStrikerId} onChange={e => setOpenStrikerId(e.target.value)}>
                    {openBatters.map(p => <option key={p._id} value={p._id}>{p.fullName}</option>)}
                  </select>
                </div>
                <div>
                  <label>Non-striker</label>
                  <select value={openNonStrikerId} onChange={e => setOpenNonStrikerId(e.target.value)}>
                    {openBatters.map(p => <option key={p._id} value={p._id}>{p.fullName}</option>)}
                  </select>
                </div>
                <div>
                  <label>Bowler</label>
                  <select value={openBowlerId} onChange={e => setOpenBowlerId(e.target.value)}>
                    <option value="">(select)</option>
                    {openBowlers.map(p => <option key={p._id} value={p._id}>{p.fullName}</option>)}
                  </select>
                </div>
              </div>
              <div style={{ marginTop: 8 }}>
                <button className="btn-accent" onClick={confirmOpeners} disabled={!openStrikerId || !openNonStrikerId || openStrikerId === openNonStrikerId}>Confirm</button>
              </div>
              <div className="sub" style={{ marginTop: 6 }}>Scoring is blocked until openers are set.</div>
            </div>
          )}

          {/* New batter modal */}
          {needNewBatter && (
            <div className="card">
              <div className="h1">New Batter</div>
              <div className="row row-2">
                <div>
                  <label>
                    Select replacement for <b>{state?.waitingForNewBatterEnd === "non-striker" ? "Non-striker" : "Striker"}</b>
                  </label>
                  <select value={newBatterId} onChange={e => setNewBatterId(e.target.value)}>
                    {availableBatters.map(p => <option key={p._id} value={p._id}>{p.fullName}</option>)}
                  </select>
                </div>
                <div style={{ display: "flex", alignItems: "end" }}>
                  <button className="btn-accent" onClick={confirmNewBatter} disabled={!newBatterId}>Confirm</button>
                </div>
              </div>
            </div>
          )}

          {/* Scoring */}
          <div className="card">
            <div className="h1">Score</div>
            <div className="grid-6" style={{ marginBottom: 8 }}>
              {[0, 1, 2, 3, 4, 6].map(n => <button key={n} onClick={() => sendBall({ runs: n, kind: "normal" })} disabled={(state as any).waitingForOpeners || state.waitingForNewBatter || finished}>{n}</button>)}
            </div>
            <div className="grid-4">
              <button onClick={() => sendBall({ runs: 0, kind: "wide" })} disabled={(state as any).waitingForOpeners || state.waitingForNewBatter || finished}>Wide +1</button>
              <button onClick={() => sendBall({ runs: 0, kind: "no-ball" })} disabled={(state as any).waitingForOpeners || state.waitingForNewBatter || finished}>No-ball +1</button>
              <button onClick={() => sendBall({ runs: 1, kind: "bye" })} disabled={(state as any).waitingForOpeners || state.waitingForNewBatter || finished}>Bye 1</button>
              <button onClick={() => sendBall({ runs: 1, kind: "leg-bye" })} disabled={(state as any).waitingForOpeners || state.waitingForNewBatter || finished}>Leg-bye 1</button>
              <button
                onClick={() => { setDismissalType("caught"); setOutEnd("striker"); setShowWicket(true); }}
                style={{ background: "linear-gradient(180deg,#3a1111,#5a1d1d)", border: "1px solid #5a1d1d" }}
                disabled={(state as any).waitingForOpeners || finished}
              >
                Wicket
              </button>
            </div>
          </div>

          {/* Wicket dialog */}
          {showWicket && (
            <div className="card">
              <div className="h1">Wicket</div>
              <div className="row row-3">
                <div>
                  <label>Dismissal type</label>
                  <select value={dismissalType} onChange={e => setDismissalType(e.target.value)}>
                    {["caught", "bowled", "lbw", "runout", "stumped", "hitwicket"].map(w => <option key={w} value={w}>{w}</option>)}
                  </select>
                </div>
                {dismissalType === "runout" && (
                  <div>
                    <label>Who is out?</label>
                    <select value={outEnd} onChange={e => setOutEnd(e.target.value as "striker" | "non-striker")}>
                      <option value="striker">Striker</option>
                      <option value="non-striker">Non-striker</option>
                    </select>
                  </div>
                )}
                <div style={{ display: "flex", alignItems: "end", gap: 8 }}>
                  <button onClick={() => setShowWicket(false)}>Cancel</button>
                  <button
                    className="btn-accent"
                    onClick={async () => {
                      await sendBall({ runs: 0, kind: "normal", wicket: true }, dismissalType, dismissalType === "runout" ? outEnd : undefined);
                      setShowWicket(false);
                    }}
                  >
                    Confirm
                  </button>
                </div>
              </div>
              {state?.nextBallFreeHit && <div className="sub" style={{ marginTop: 6 }}>Next ball is a FREE-HIT (only run-out allowed).</div>}
            </div>
          )}
        </>
      )}
    </>
  );
}

/* ----------------- Tournaments: list & detail ----------------- */
function TournamentsList() {
  const [ts, setTs] = useState<Tournament[]>([]);
  useEffect(() => { fetchJSON(`${API}/api/tournaments`).then(setTs); }, []);
  return (
    <div className="card">
      <div className="h1">Tournaments</div>
      {!ts.length && <div className="sub">No tournaments yet.</div>}
      {!!ts.length && (
        <div style={{ display: "grid", gap: 8 }}>
          {ts.map(t => (
            <div key={t._id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>{t.name}</div>
              <Link className="btn" to={`/tournaments/${t._id}`}>Open</Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TournamentDetail() {
  const { id = "" } = useParams();
  const [standings, setStandings] = useState<any>({ groups: [] });
  const [players, setPlayers] = useState<any[]>([]);
  const [teams, setTeams] = useState<Record<string, string>>({});

  useEffect(() => {
    (async () => {
      const sts = await fetchJSON(`${API}/api/tournaments/${id}/standings`);
      setStandings(sts);
      const rows = await fetchJSON(`${API}/api/stats/players?tournamentId=${id}&limit=200`);
      setPlayers(rows);
      const tms: Team[] = await fetchJSON(`${API}/api/teams`);
      const map: Record<string, string> = {}; tms.forEach(t => map[t._id] = t.name); setTeams(map);
    })();
  }, [id]);

  return (
    <>
      <div className="card">
        <div className="h1">League Table</div>
        {(!standings.groups || !standings.groups.length) && <div className="sub">No standings yet.</div>}
        {standings.groups?.map((g: any) => (
          <div key={g.groupId} style={{ marginTop: 12 }}>
            <div className="sub" style={{ fontWeight: 600 }}>{g.groupName}</div>
            <table className="table" style={{ marginTop: 6 }}>
              <thead>
                <tr>
                  <th>#</th><th>Team</th>
                  <th className="right">P</th><th className="right">W</th><th className="right">L</th><th className="right">T</th><th className="right">NR</th>
                  <th className="right">Pts</th><th className="right">NRR</th>
                </tr>
              </thead>
              <tbody>
                {g.table.map((r: any, i: number) => (
                  <tr key={r.teamId}>
                    <td>{i + 1}</td>
                    <td>{r.teamName}</td>
                    <td className="right">{r.played}</td>
                    <td className="right">{r.won}</td>
                    <td className="right">{r.lost}</td>
                    <td className="right">{r.tied}</td>
                    <td className="right">{r.noResult}</td>
                    <td className="right">{r.points}</td>
                    <td className="right">{r.nrr.toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="h1">Player Stats</div>
        <div className="sub">Across this tournament</div>
        <table className="table" style={{ marginTop: 6 }}>
          <thead>
            <tr>
              <th>Player</th><th>Team</th>
              <th className="right">Runs</th><th className="right">BF</th><th className="right">4s</th><th className="right">6s</th><th className="right">SR</th>
              <th className="right">Wkts</th><th className="right">Overs</th><th className="right">R</th><th className="right">Econ</th>
            </tr>
          </thead>
          <tbody>
            {players.map((r: any) => (
              <tr key={r.playerId}>
                <td>{r.playerName}</td>
                <td>{r.teamName || teams[r.teamId] || "—"}</td>
                <td className="right">{r.runs}</td>
                <td className="right">{r.ballsFaced}</td>
                <td className="right">{r.fours}</td>
                <td className="right">{r.sixes}</td>
                <td className="right">{Number(r.strikeRate || 0).toFixed(1)}</td>
                <td className="right">{r.wickets}</td>
                <td className="right">{Math.floor((r.ballsBowled || 0) / 6)}.{(r.ballsBowled || 0) % 6}</td>
                <td className="right">{r.runsConceded}</td>
                <td className="right">{Number(r.economy || 0).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ----------------- Home ----------------- */
function Home() {
  return (
    <div className="card">
      <div className="h1">🏏 Cricket Tournament</div>
      <div className="sub">Pick where to go:</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        <Link to="/viewer" className="btn">Watch Live</Link>
        <Link to="/tournaments" className="btn">Tournaments</Link>
        <Link to="/admin" className="btn-accent">Admin</Link>
      </div>
    </div>
  );
}

/* ----------------- App (Router) ----------------- */
export default function App() {
  return (
    <BrowserRouter>
      <div className="container">
        <nav className="topnav">
          <NavLink to="/" end className={({ isActive }) => cls("toplink", isActive && "active")}>Home</NavLink>
          <NavLink to="/viewer" className={({ isActive }) => cls("toplink", isActive && "active")}>Viewer</NavLink>
          <NavLink to="/tournaments" className={({ isActive }) => cls("toplink", isActive && "active")}>Tournaments</NavLink>
          <NavLink to="/admin" className={({ isActive }) => cls("toplink", isActive && "active")}>Admin</NavLink>
        </nav>

        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/viewer" element={<ViewerList />} />
          <Route path="/viewer/:matchId" element={<ViewerPage />} />
          <Route path="/tournaments" element={<TournamentsList />} />
          <Route path="/tournaments/:id" element={<TournamentDetail />} />
          <Route path="/admin/login" element={<AdminLogin />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="*" element={<div className="card"><div className="sub">Not found</div></div>} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
