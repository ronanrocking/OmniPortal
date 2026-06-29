# OmniPortal Host V1

This Electron app is the first real installed host for OmniPortal.

It no longer just opens the hosted browser page.

Instead, it has its own local UI and host config, generates a persistent host identity, registers that host with the backend, opens a dedicated host WebSocket, and participates in the same WebRTC chat/signaling flow as the browser prototype.

## What it does

- persists `host_id`, `host_code`, `display_name`, and `server_url` locally
- auto-detects the local device name
- registers the host with the backend through `/api/host-v1/register`
- stays online through `/ws/host-v1`
- supports one active client pairing at a time
- exchanges direct WebRTC chat messages with the connected client

## Default backend target

By default, the app uses:

- `https://omniportal.ronanrocking.com`

You can still override the startup default before launching Electron:

- PowerShell: `$env:OMNIPORTAL_SERVER_URL="https://your-server.example"; npm start`

## First-time setup

From this folder:

```powershell
npm install
```

## Run locally

```powershell
npm start
```

## Build Windows installer

```powershell
npm run dist
```

Build output will be written to:

- `apps/host/dist`

## Current scope

This matches Host V1 scope:

- host identity persistence
- backend registration
- online presence and heartbeat
- single-session pairing
- WebRTC signaling
- direct data channel chat

It does not yet include:

- screen capture
- remote input control
- file transfer
- background service behavior
