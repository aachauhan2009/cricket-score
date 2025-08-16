
# Cricket Realtime (Mongo + Express + React + Socket.IO) — Admin Edition

## Quick start (Docker)
```bash
docker-compose up --build
# web: http://localhost:5173
# api: http://localhost:4000
```

## Admin import + start match
Open the web app and:
1) Use **Admin • Import** to paste JSON of tournament, groups, teams, players, groupTeams, matches.
2) Use **Start Match** to select Tournament → Group → Match, set striker/non-striker, and start.

### Example JSON
(Pre-filled in the UI)
```json
{
  "tournament": { "name": "Summer Cup" },
  "groups": [{ "name": "Group A" }],
  "teams": [{ "name": "India", "shortName": "IND" }, { "name": "Australia", "shortName": "AUS" }],
  "players": [
    { "teamName": "India", "fullName": "Rohit Sharma" },
    { "teamName": "India", "fullName": "Virat Kohli" },
    { "teamName": "Australia", "fullName": "David Warner" },
    { "teamName": "Australia", "fullName": "Steve Smith" }
  ],
  "groupTeams": [
    { "groupName": "Group A", "teamName": "India" },
    { "groupName": "Group A", "teamName": "Australia" }
  ],
  "matches": [
    { "title": "Match 1", "groupName": "Group A", "teamA": "India", "teamB": "Australia", "maxOvers": 20 }
  ]
}
```
