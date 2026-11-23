---
description: Type-check, build and deploy the terminal to the Lighthouse VPS, then verify it is serving
---

Deploy this project to `ubuntu@43.156.117.143` (`~/app`, PM2 app `dashboard`, port 3000 behind Nginx on port 80).

1. Run `npx tsc --noEmit`. If it reports errors, stop and show them — do not deploy.
2. Run `./deploy.sh` from the project root (it builds into `.next-prod`, rsyncs, installs production
   dependencies, restarts PM2 and saves the process list). If the user's key is not the default one,
   run it as `SSH_KEY=<path> ./deploy.sh`. Run it in the background if it may take over two minutes.
   If it fails, show the failing step and the last lines of output, and stop.
3. Run `ssh ubuntu@43.156.117.143 'pm2 status dashboard'` and confirm the app is `online`
   (use the same `-i` key as step 2 if one was needed).
4. Run `curl -I https://43.156.117.143` and confirm the first line is `HTTP/2 200` (plain `http://` answers `301` to HTTPS).
5. Report: what was deployed, the PM2 status line, and the HTTP status. If anything is not 200/online,
   pull `pm2 logs dashboard --lines 50 --nostream` and say what it shows.
