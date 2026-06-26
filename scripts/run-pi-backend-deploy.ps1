$ErrorActionPreference = "Stop"

$repoPath = "/home/codex/OmniPortal"
$remoteScriptPath = "$repoPath/scripts/pi-backend-deploy.sh"

ssh pi "mkdir -p $repoPath/scripts"
ssh pi "mkdir -p $repoPath/apps/backend"
scp "D:\PWD\OmniPortal\docker-compose.yml" "pi:${repoPath}/docker-compose.yml"
scp "D:\PWD\OmniPortal\apps\backend\Dockerfile" "pi:${repoPath}/apps/backend/Dockerfile"
scp "D:\PWD\OmniPortal\apps\backend\requirements.txt" "pi:${repoPath}/apps/backend/requirements.txt"
scp "D:\PWD\OmniPortal\apps\backend\main.py" "pi:${repoPath}/apps/backend/main.py"
$scriptContent = Get-Content -Raw "D:\PWD\OmniPortal\scripts\pi-backend-deploy.sh"
$scriptContent | ssh pi "cat > $remoteScriptPath && tr -d '\r' < $remoteScriptPath > ${remoteScriptPath}.tmp && mv ${remoteScriptPath}.tmp $remoteScriptPath && chmod +x $remoteScriptPath"
ssh pi "SKIP_GIT_UPDATE=1 bash $remoteScriptPath $repoPath"
