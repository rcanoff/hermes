param(
    [Parameter(Position = 0)]
    [ValidateSet("up", "down", "ps", "logs", "config", "restart", "env", "sync-apple-calendar-mcp-token")]
    [string]$Command = "help"
)

$ErrorActionPreference = "Stop"

function Get-EnvFile {
    if (Test-Path ".env") {
        return ".env"
    }

    return ".env.example"
}

function Get-HostIdValue {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [int]$Fallback
    )

    $value = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($value)) {
        return $Fallback
    }

    return $value
}

function Sync-AppleCalendarMcpToken {
    param(
        [Parameter(Mandatory = $true)]
        [string]$EnvFile,
        [Parameter(Mandatory = $true)]
        [string]$ConfigFile
    )

    if (-not (Test-Path $EnvFile)) {
        throw "Missing env file: $EnvFile"
    }

    if (-not (Test-Path $ConfigFile)) {
        throw "Missing config file: $ConfigFile"
    }

    $envVars = @{}
    foreach ($line in Get-Content $EnvFile) {
        if ($line -match '^\s*#' -or [string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        $parts = $line -split '=', 2
        if ($parts.Count -eq 2) {
            $envVars[$parts[0].Trim()] = $parts[1]
        }
    }

    $token = $envVars["CALDAV_MCP_BEARER_TOKEN"]
    if ([string]::IsNullOrWhiteSpace($token)) {
        throw "CALDAV_MCP_BEARER_TOKEN is empty in $EnvFile"
    }

    $lines = Get-Content $ConfigFile
    $insideAppleCalendar = $false
    $insideHeaders = $false
    $updated = $false

    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]

        if ($line -eq "  apple_calendar:") {
            $insideAppleCalendar = $true
            $insideHeaders = $false
            continue
        }

        if ($insideAppleCalendar -and $line.StartsWith("  ") -and -not $line.StartsWith("    ")) {
            $insideAppleCalendar = $false
            $insideHeaders = $false
        }

        if ($insideAppleCalendar -and $line -eq "    headers:") {
            $insideHeaders = $true
            continue
        }

        if ($insideHeaders -and $line.StartsWith("      Authorization: Bearer ")) {
            $lines[$i] = "      Authorization: Bearer $token"
            $insideHeaders = $false
            $updated = $true
        }
    }

    if (-not $updated) {
        throw "Apple Calendar Authorization header not found in $ConfigFile"
    }

    Set-Content -Path $ConfigFile -Value $lines
    Write-Output "Synced Apple Calendar MCP token in $ConfigFile from $EnvFile"
}

function Invoke-DockerCompose {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $env:HERMES_UID = Get-HostIdValue -Name "HERMES_UID" -Fallback 1000
    $env:HERMES_GID = Get-HostIdValue -Name "HERMES_GID" -Fallback 1000
    $envFile = Get-EnvFile

    & docker compose --env-file $envFile @Arguments
}

switch ($Command) {
    "up" {
        $envFile = Get-EnvFile
        Sync-AppleCalendarMcpToken -EnvFile $envFile -ConfigFile "data/config.yaml"
        Invoke-DockerCompose -Arguments @("up", "-d")
    }
    "down" {
        Invoke-DockerCompose -Arguments @("down")
    }
    "ps" {
        Invoke-DockerCompose -Arguments @("ps")
    }
    "logs" {
        Invoke-DockerCompose -Arguments @("logs", "--tail=150", "hermes-gateway")
    }
    "config" {
        $envFile = Get-EnvFile
        Sync-AppleCalendarMcpToken -EnvFile $envFile -ConfigFile "data/config.yaml"
        Invoke-DockerCompose -Arguments @("config")
    }
    "restart" {
        Invoke-DockerCompose -Arguments @("restart")
    }
    "env" {
        $envFile = Get-EnvFile
        $uid = Get-HostIdValue -Name "HERMES_UID" -Fallback 1000
        $gid = Get-HostIdValue -Name "HERMES_GID" -Fallback 1000
        Write-Output "ENV_FILE=$envFile"
        Write-Output "HERMES_UID=$uid"
        Write-Output "HERMES_GID=$gid"
    }
    "sync-apple-calendar-mcp-token" {
        $envFile = Get-EnvFile
        Sync-AppleCalendarMcpToken -EnvFile $envFile -ConfigFile "data/config.yaml"
    }
}
