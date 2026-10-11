## CHECKPOINT 1

- **Built:** Docker Compose environment with PostgreSQL 17 and Redis 7, including health checks and persistent PostgreSQL storage.
- **Problem encountered:** Host port 5432 was occupied by an existing Windows PostgreSQL process; mapped Docker PostgreSQL to host port 5433.
- **Learned:** Container ports differ from host ports; named volumes preserve PostgreSQL data across container restarts; container health checks verify service readiness.
- **Verified:** Both containers healthy, Redis `PING` returned `PONG`, PostgreSQL query succeeded, and a test record survived a container restart.
- **Interview question:** What happens to database data when a container is restarted or removed, and how do named volumes help?