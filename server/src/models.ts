import mongoose, { Schema } from "mongoose";

/* ---------- Core ---------- */
export const TeamSchema = new Schema({
  name: { type: String, required: true, unique: true },
  shortName: String
}, { timestamps: true });

export const PlayerSchema = new Schema({
  teamId: { type: Schema.Types.ObjectId, ref: "Team", required: true },
  fullName: { type: String, required: true },
  role: String,
  battingStyle: String,
  bowlingStyle: String
}, { timestamps: true });

export const TournamentSchema = new Schema({
  name: { type: String, required: true },
  startDate: Date,
  endDate: Date
}, { timestamps: true });

export const GroupSchema = new Schema({
  tournamentId: { type: Schema.Types.ObjectId, ref: "Tournament", required: true },
  name: { type: String, required: true }
}, { timestamps: true });
GroupSchema.index({ tournamentId: 1, name: 1 }, { unique: true });

export const GroupTeamSchema = new Schema({
  groupId: { type: Schema.Types.ObjectId, ref: "Group", required: true },
  teamId: { type: Schema.Types.ObjectId, ref: "Team", required: true }
}, { timestamps: true });
GroupTeamSchema.index({ groupId: 1, teamId: 1 }, { unique: true });

/* ---------- Match & Live State ---------- */
export const MatchSchema = new Schema({
  title: { type: String, required: true },
  teamAId: { type: Schema.Types.ObjectId, ref: "Team", required: true },
  teamBId: { type: Schema.Types.ObjectId, ref: "Team", required: true },
  maxOvers: { type: Number, default: 6 },
  status: { type: String, enum: ["scheduled", "live", "finished"], default: "scheduled" },
  tournamentId: { type: Schema.Types.ObjectId, ref: "Tournament" },
  groupId: { type: Schema.Types.ObjectId, ref: "Group" }
}, { timestamps: true });

export const MatchStateSchema = new Schema({
  matchId: { type: Schema.Types.ObjectId, ref: "Match", unique: true, required: true },

  // Current innings tally
  runs: { type: Number, default: 0 },
  wickets: { type: Number, default: 0 },
  balls: { type: Number, default: 0 }, // legal balls only

  // On-field names (for quick UI), and ids (for stats)
  striker: String,
  nonStriker: String,
  bowler: String,
  strikerId: { type: Schema.Types.ObjectId, ref: "Player" },
  nonStrikerId: { type: Schema.Types.ObjectId, ref: "Player" },
  bowlerId: { type: Schema.Types.ObjectId, ref: "Player" },

  lastEvent: String,
  currentInningsId: { type: Schema.Types.ObjectId, ref: "Innings" },

  // Rules/flow flags
  nextBallFreeHit: { type: Boolean, default: false },

  // Force new batter after wicket, and which end needs replacement
  waitingForNewBatter: { type: Boolean, default: false },
  waitingForNewBatterEnd: { type: String, enum: ["striker", "non-striker"], default: "striker" },

  // NEW: when second innings begins, scorer must choose openers & first bowler
  waitingForOpeners: { type: Boolean, default: false }
}, { timestamps: true });

export const MatchSquadSchema = new Schema({
  matchId: { type: Schema.Types.ObjectId, ref: "Match", required: true },
  playerId: { type: Schema.Types.ObjectId, ref: "Player", required: true },
  teamId: { type: Schema.Types.ObjectId, ref: "Team", required: true },
  isPlaying: { type: Boolean, default: true }
}, { timestamps: true });
MatchSquadSchema.index({ matchId: 1, playerId: 1 }, { unique: true });

export const InningsSchema = new Schema({
  matchId: { type: Schema.Types.ObjectId, ref: "Match", required: true },
  battingTeamId: { type: Schema.Types.ObjectId, ref: "Team", required: true },
  bowlingTeamId: { type: Schema.Types.ObjectId, ref: "Team", required: true },
  runs: { type: Number, default: 0 },
  wickets: { type: Number, default: 0 },
  legalBalls: { type: Number, default: 0 },
  extras: { type: Number, default: 0 },
  startedAt: { type: Date, default: Date.now },
  endedAt: Date
}, { timestamps: true });

/* ---------- Events, Results & Stats ---------- */
export const BallEventSchema = new Schema({
  matchId: { type: Schema.Types.ObjectId, ref: "Match", required: true },
  inningsId: { type: Schema.Types.ObjectId, ref: "Innings", required: true },
  batterId: { type: Schema.Types.ObjectId, ref: "Player" },
  bowlerId: { type: Schema.Types.ObjectId, ref: "Player" },
  runs: { type: Number, default: 0 }, // bat runs
  wicket: { type: Boolean, default: false },
  kind: { type: String, enum: ["normal", "wide", "no-ball", "bye", "leg-bye", "wicket"], default: "normal" },
  ballsBefore: { type: Number, required: true },
  note: String,

  // Extra info for dismissals
  dismissalType: { type: String },              // e.g., "caught","bowled","lbw","runout","stumped"
  outEnd: { type: String, enum: ["striker", "non-striker", ""], default: "" } // for run-outs
}, { timestamps: true });

export const MatchResultSchema = new Schema({
  matchId: { type: Schema.Types.ObjectId, ref: "Match", unique: true, required: true },
  winnerTeamId: { type: Schema.Types.ObjectId, ref: "Team" },
  loserTeamId: { type: Schema.Types.ObjectId, ref: "Team" },
  isTie: { type: Boolean, default: false },
  isNoResult: { type: Boolean, default: false }
}, { timestamps: true });

export const PlayerStatsSchema = new Schema({
  matchId: { type: Schema.Types.ObjectId, ref: "Match", required: true },
  playerId: { type: Schema.Types.ObjectId, ref: "Player", required: true },
  teamId: { type: Schema.Types.ObjectId, ref: "Team", required: true },

  // batting
  runs: { type: Number, default: 0 },
  ballsFaced: { type: Number, default: 0 },
  fours: { type: Number, default: 0 },
  sixes: { type: Number, default: 0 },
  isOut: { type: Boolean, default: false },
  howOut: String,

  // bowling
  ballsBowled: { type: Number, default: 0 },
  runsConceded: { type: Number, default: 0 },
  wickets: { type: Number, default: 0 },

  // fielding (optional)
  catches: { type: Number, default: 0 },
  runouts: { type: Number, default: 0 }
}, { timestamps: true });

PlayerStatsSchema.index({ matchId: 1, playerId: 1 }, { unique: true });

/* ---------- Exports ---------- */
export const Team = mongoose.model("Team", TeamSchema);
export const Player = mongoose.model("Player", PlayerSchema);
export const Tournament = mongoose.model("Tournament", TournamentSchema);
export const Group = mongoose.model("Group", GroupSchema);
export const GroupTeam = mongoose.model("GroupTeam", GroupTeamSchema);
export const Match = mongoose.model("Match", MatchSchema);
export const MatchState = mongoose.model("MatchState", MatchStateSchema);
export const MatchSquad = mongoose.model("MatchSquad", MatchSquadSchema);
export const Innings = mongoose.model("Innings", InningsSchema);
export const BallEvent = mongoose.model("BallEvent", BallEventSchema);
export const MatchResult = mongoose.model("MatchResult", MatchResultSchema);
export const PlayerStats = mongoose.model("PlayerStats", PlayerStatsSchema);
