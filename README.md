# Advice Tracker test monitor

A page for the Advice Tracker study team. It shows what the study's participants are doing with the
extension, as it happens: the judgments of their chat turns, the answers they give, their check-ins,
whether the extension is tracking, and which judgments the study server is working on right now. The
conversations participants share appear with their text only for test participants (participant IDs that
start with `TEST-`); for everyone else the page shows how many messages a conversation has, not what they
say.

## This repository holds no data

The page is four static files: `index.html`, `app.js`, `style.css`, and `config.js`, which only names
the study server. There is no data here, and none is ever added: nothing about any participant is
stored on GitHub.

After you sign in with a study-team account, your browser asks the study server for the data directly
and shows it. The server sends no conversation text of anyone but test participants. Your
session is kept in the tab only (`sessionStorage`): the tab forgets it when you close it or sign out, and
the server stops accepting it 12 hours after you signed in.

## Accounts

The study team makes accounts on the study server. Ask the person who runs it for one. Your password
goes only to the study server, when you sign in; the page does not keep it.

## Changing the page

These files are published from the study's serving repository (its `dashboard/` folder). Change them
there, not here: the next publish replaces everything in this repository.
