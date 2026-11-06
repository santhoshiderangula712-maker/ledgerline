\# PROMPTS.md



Each entry: date | what I asked | what it produced | what was wrong | what I did instead | commit link.



\## 2026-11-05

\- Asked Claude for a 7-day plan and tonight's setup steps from the brief.

\- It gave Linux-style commands (`mkdir -p`, `git init` before cloning) that misbehaved on my Windows machine and created a stray `-p` folder. I deleted the folder and re-cloned the repo from GitHub.

\- (Money-integrity entries will come from the actual code, starting Friday.)


## 2026-11-05 (second entry): leaked database credential

- **What I asked:** Claude helped me set up a Neon Postgres database and a `.env` file, and told me to copy the connection string from Neon.
- **What went wrong (my mistake, not the AI's):** I pasted the full connection string, including the real password, into the chat while asking for help. That exposed the credential.
- **What the AI did:** It told me to treat the credential as compromised and to reset the password before doing anything else.
- **What I did instead:** I reset the `neondb_owner` password in Neon, put the new connection string only in my local `.env` file and in Render's environment settings, and confirmed `.env` is ignored by git (`git status` does not list it).
- **Rule going forward:** secrets go only in `.env` and the host's environment settings. Never in chat, README, PROMPTS.md or a commit. If I need help with an error, I share the error text only.
- **Commit:** (add the commit link after you push; see step 4)