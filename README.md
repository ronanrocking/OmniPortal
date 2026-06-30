# OmniPortal
Browser based remote PC/Desktop controlling service. (Anydesk for browser)

## TURN relay testing

The backend now serves a full WebRTC ICE server array from `/api/config`. It can fetch Metered TURN credentials from your app-specific `apiKey`, or fall back to a static ICE array if you prefer to pin the exact relay config.

You can override that behavior later with environment variables:

- `OMNI_METERED_APP_NAME` and `OMNI_METERED_CREDENTIAL_API_KEY` to fetch ICE directly from your Metered app
- Leave `OMNI_METERED_REGION` blank on the free tier; Metered rejects `region=standard` in API requests
- `OMNI_ICE_SERVERS_JSON` to provide the full ICE array directly as JSON
- `OMNI_TURN_URIS`, `OMNI_TURN_USERNAME`, `OMNI_TURN_CREDENTIAL` for a custom TURN host or VPS
- `OMNI_USE_OPENRELAY=1` only if you intentionally want the public OpenRelay test fallback

The `/api/config` response now also reports `ice_source` so you can confirm whether the backend is using `metered_api`, `static_ice_json`, or another fallback path.
