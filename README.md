# OmniPortal

OmniPortal is a browser-to-host remote access project.

The long-term goal is to make it possible for someone to open a browser, connect to a remote computer through a simple pairing flow, and interact with that machine without the usual install-heavy remote support friction on the client side.

You can think of it as aiming toward:

- browser-based remote support
- browser-based remote desktop access
- lightweight host installation
- reliable cross-network connectivity
- a simple pairing experience for non-technical users

## Vision

OmniPortal is being shaped around a few core ideas:

- the client should be able to connect from a normal browser
- the host should be easy to install and leave running
- connection setup should be simple enough for real support scenarios
- direct peer-to-peer connectivity should be preferred when possible
- relay infrastructure should exist for restrictive networks

Over time, the project is expected to grow from basic session establishment into a fuller remote access stack with:

- screen sharing
- remote input control
- better session diagnostics
- stronger reliability across different NAT and firewall conditions

## Architecture Direction

The platform is organized around three major pieces:

- a backend that handles discovery, pairing, and signaling
- a browser client that connects to hosts
- an installed desktop host application that represents the remote machine

The networking model is WebRTC-first:

- direct connection when possible
- TURN relay fallback when needed

That design keeps the experience flexible enough for both local-network and internet-wide use.

## Networking

OmniPortal’s backend serves WebRTC ICE configuration from `/api/config`.

The project supports multiple relay configuration paths so it can evolve from testing setups into more production-like infrastructure:

- Metered credential API
- static ICE JSON
- custom TURN credentials from environment variables
- self-hosted coturn using temporary TURN REST credentials
- optional OpenRelay fallback when intentionally enabled

Useful environment variables include:

- `OMNI_METERED_APP_NAME`
- `OMNI_METERED_CREDENTIAL_API_KEY`
- `OMNI_METERED_REGION`
- `OMNI_ICE_SERVERS_JSON`
- `OMNI_TURN_URIS`
- `OMNI_TURN_USERNAME`
- `OMNI_TURN_CREDENTIAL`
- `OMNI_TURN_REST_SECRET`
- `OMNI_TURN_REST_TTL_SECONDS`
- `OMNI_TURN_REST_USERNAME_PREFIX`
- `OMNI_USE_OPENRELAY`

The `/api/config` response also reports `ice_source`, which helps confirm which relay path is active at runtime.

## Current Codebase Areas

- `apps/backend`: FastAPI backend for registration, pairing, presence, and signaling
- `apps/frontend`: browser client and frontend assets
- `apps/host`: Electron desktop host application for Windows
- `scripts`: deployment helpers
- `docs/private/handoff`: local handoff notes for agents working in this repo

## Where The Project Is Heading

The repository should be read as infrastructure for a future browser-native remote access product, not just a chat-over-WebRTC experiment.

Even when the current implementation is narrower than the final vision, the intended destination is broader:

- a real remote host experience
- browser-driven support sessions
- resilient connectivity across difficult networks
- a path toward practical remote desktop control
