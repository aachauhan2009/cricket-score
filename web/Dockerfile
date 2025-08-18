# ---------- Build the React app ----------
FROM node:20-alpine AS build
WORKDIR /web
COPY package*.json ./
RUN npm ci
COPY . .
# If you use Vite and want same-origin in prod, keep VITE_API_BASE/VITE_SOCKET_URL empty
# ENV VITE_API_BASE=
# ENV VITE_SOCKET_URL=
RUN npm run build

# ---------- Export the build as an artifact ----------
# This image contains only the compiled assets at /dist
FROM alpine:3.20 AS artifact
WORKDIR /dist
COPY --from=build /web/dist ./

# Optional: helpful when used as a sidecar in docker-compose to share files
VOLUME ["/dist"]
CMD ["sh", "-c", "ls -lah /dist && echo 'Frontend build ready at /dist'; tail -f /dev/null"]
