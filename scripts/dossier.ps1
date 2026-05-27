#requires -Version 7.0
<#
.SYNOPSIS
    DOSSIER v3 — produce a complete intelligence dossier on a creator from an
    Instagram / TikTok / YouTube Shorts URL (or batch of URLs, or watchlist).

    Pipeline (per-URL, platform-agnostic shape):
      Platform-specific scrape  -> source.mp4
      -> 1fps frames + audio
      -> Whisper transcription (optional, soft-fail)
      -> Profile chase (Instagram only, soft-fail)
      -> manifest.json + BRIEF.md + index.html
      -> Auto-Playwright tour via `claude` CLI    (-NoTour to skip)
      -> Auto-recipe synthesis via `claude` CLI   (-NoRecipe to skip)

    NEW IN v3:
      A. Auto-Playwright tour (replaces manual paste step) — invokes `claude` CLI
      B. Multi-platform: Instagram + TikTok + YouTube Shorts
      C. Batch mode (.txt file, parallel jobs, BATCH-SUMMARY.md)
      D. Smart 24h cache (-Force to bypass)
      E. HTML brief (index.html, dark theme, auto-opens)
      F. Daily watchlist (-Watch users.txt; -InstallWatchTask to schedule)
      G. Auto-recipe synthesis (RECIPE.md via claude CLI)

    v3.1 progress:
      H. NotebookLM auto-pipe (SHIPPED) — transcript+BRIEF+RECIPE -> 3 sources per dossier
         per creator. Optional Audio Overview at source-count thresholds 5/10/25.
         Flags: -NoNotebookLM, -Notebook <name>, -AutoPodcast.
      I. ARCHIVE atlas + per-creator SIGNATURES + append-only FROM-CLAUDE.md (SHIPPED)
      J. META hub (-UpdateMeta runs 3 parallel claude streams, synthesizes META.md) (SHIPPED)
      K. Firecrawl portfolio crawl (-FirecrawlPortfolio after Playwright tour) (SHIPPED)

.PARAMETER Url
    Either:
      - A single video URL (Instagram /p/ /reel/, TikTok /@user/video/ or vm.tiktok.com,
        YouTube /shorts/ or youtu.be)
      - Path to a .txt file containing one URL per line (lines starting with # are comments)

.PARAMETER Force
    Bypass the 24h cache and re-scrape.

.PARAMETER NoTour
    Skip the auto-Playwright portfolio tour (even if `claude` CLI is on PATH and
    creator has externalUrl).

.PARAMETER NoRecipe
    Skip the auto-recipe synthesis step (even if `claude` CLI is on PATH).

.PARAMETER NoOpen
    Don't auto-open index.html when the run completes.

.PARAMETER NoNotebookLM
    Skip the post-run NotebookLM auto-pipe (v3.1 Feature A) entirely. Use when
    the claude CLI or NotebookLM auth is unavailable or you don't want the
    sources added to a notebook for this run.

.PARAMETER Notebook
    Override the default notebook name. Default is "Creator: @<ownerUsername>"
    so all of a creator's dossiers land in the same notebook. Pass a custom
    name to group dossiers by topic / project instead.

.PARAMETER AutoPodcast
    When the target notebook reaches a source-count threshold (5, 10, or 25)
    after this run's sources are added, also fire an Audio Overview generation
    via mcp__notebooklm-mcp__studio_create. Off by default — generation
    consumes NotebookLM podcast quota.

.PARAMETER MaxParallel
    Maximum number of parallel jobs in batch mode. Default 4. Going higher risks
    Apify rate-limits and machine slowdown.

.PARAMETER Watch
    Watchlist mode. Either a comma-separated list of usernames (no @) or a .txt file
    with one username per line. Scrapes each profile, finds new posts since last scan,
    runs dossier on each new post, writes WATCH-DIGEST-YYYY-MM-DD.md.

.PARAMETER InstallWatchTask
    Helper subcommand. Registers a Windows Scheduled Task that runs the watchlist
    daily at the time given by -Time. Requires -Watch. Example:
      .\dossier.ps1 -InstallWatchTask -Watch users.txt -Time 08:00

.PARAMETER Time
    Time-of-day for -InstallWatchTask. Format HH:mm (24h). Default 08:00.

.PARAMETER Help
    Print usage and exit.

.EXAMPLE
    # Single URL (any platform):
    .\dossier.ps1 https://www.instagram.com/p/DXZX5pHkVHt/
    .\dossier.ps1 https://www.tiktok.com/@user/video/7398101551744552225
    .\dossier.ps1 https://www.youtube.com/shorts/abc123

.EXAMPLE
    # Batch mode:
    .\dossier.ps1 urls.txt
    .\dossier.ps1 urls.txt -MaxParallel 2

.EXAMPLE
    # Daily watchlist:
    .\dossier.ps1 -Watch users.txt
    .\dossier.ps1 -Watch alex,jerry,fyodor -Force

.EXAMPLE
    # Schedule the watchlist:
    .\dossier.ps1 -InstallWatchTask -Watch users.txt -Time 08:00

.NOTES
    Requires: ffmpeg on PATH, PowerShell 7+. Apify token will be prompted for
    on first run (and optionally saved as a User env var).
    Optional: faster-whisper / openai-whisper / whisper.cpp (transcription)
    Optional: claude CLI on PATH (auto-tour + auto-recipe)
    Optional: yt-dlp on PATH (preferred for YouTube Shorts; falls back to Apify)
#>

[CmdletBinding()]
param(
    # Positional: a single URL OR a path to a .txt batch file. Optional
    # because -Watch / -InstallWatchTask / -Help don't need it. We dispatch
    # based on which params are populated, not via parameter sets — keeps
    # the help output simple and avoids set-resolution ambiguity at parse time.
    [Parameter(Position = 0)]
    [string]$Url,

    # Watchlist mode: comma-separated usernames OR path to a .txt of usernames
    [string]$Watch,

    # Helper subcommand: register the watchlist as a Windows Scheduled Task
    [switch]$InstallWatchTask,

    # HH:mm for the scheduled task. Only consulted with -InstallWatchTask
    [string]$Time = '08:00',

    [switch]$Force,
    [switch]$NoTour,
    [switch]$NoRecipe,
    [switch]$NoOpen,
    [int]$MaxParallel = 4,

    # v3.1 Feature A — NotebookLM auto-pipe
    [switch]$NoNotebookLM,
    [string]$Notebook,
    [switch]$AutoPodcast,

    # v3.1 Feature B — THE ARCHIVE
    [switch]$NoArchive,
    [switch]$OpenArchive,
    [switch]$RebuildArchive,

    [switch]$UpdateMeta,
    [switch]$ShowMeta,
    [switch]$FirecrawlPortfolio,

    # Standalone mode: synthesize/refresh ARCHIVE/SIGNATURES/<user>.md for a specific creator
    [string]$AnalyzeCreator,

    # Standalone mode: pipe all archive dossiers tagged with <tag> into a single
    # technique-themed NotebookLM notebook (e.g. -TechniqueNotebook GSAP)
    [string]$TechniqueNotebook,

    # Verify mode: extract claims from a post transcript and verify them.
    # Pass a full URL (runs full pipeline then verifies) or a shortCode
    # (finds existing dossier folder and verifies without re-download).
    [string]$VerifyPost,

    # Echo test: write a hypothetical post in this creator's voice using
    # only their signature (ARCHIVE/SIGNATURES/<user>.md) as input.
    # Self-validates signature quality - vivid output = signature has
    # texture; generic output = signature has gaps. Requires -AnalyzeCreator
    # to have been run first (signature needs 3+ dossiers to synthesize).
    [string]$EchoTest,

    # Daily meta routine: scrape reddit, HN, GitHub trending, and blog feeds;
    # diff vs yesterday; verify claims (reuses verify-post plumbing);
    # synthesize a personalized "what changed today" digest at META-DAILY-<date>.md.
    [switch]$MetaPipe,

    # Helper subcommand: register a Windows Scheduled Task that runs -MetaPipe
    # daily at the time given by -Time. Default 07:00.
    [switch]$InstallMetaTask,

    # Minimum novelty score (1-10) for an item to survive the MetaPipe filter.
    # Default 5. Lower = more items, higher = stricter.
    [int]$NoveltyMin = 5,

    [switch]$Help
)

$ErrorActionPreference = 'Stop'

# =============================================================================
# Exit-code map (reflects actual behavior, not aspiration)
#
# $ErrorActionPreference = 'Stop' converts any non-terminating error to
# terminating, and any uncaught `throw` lands at code 1. Specific scrape /
# ffmpeg / whisper / pipeline failures all funnel through this catch-all —
# the script does not currently distinguish them by exit code. The original
# error message is printed to stderr before exit.
#
#   0  Success
#   1  Failure (catch-all): scrape error, ffmpeg failure, whisper failure,
#      pipeline crash, scheduled-task registration error, etc.
#   2  APIFY_TOKEN missing or invalid at interactive prompt
#   3  Required external tool missing on PATH (currently: ffmpeg)
#  30  Batch input file not found or empty (after dedup)
#  32  -Watch with no usernames resolved
#  50  -UpdateMeta failure: claude CLI missing, research streams empty, or
#       synth validation failed (META.md not actually rewritten)
#  52  FIRECRAWL_API_KEY missing or invalid at interactive prompt
#  55  -VerifyPost: no transcript or BRIEF found in dossier folder (shortCode path)
#  56  -VerifyPost: V1 claims extraction failed to produce parseable JSON
#  60  -MetaPipe: claude CLI absent and ANTHROPIC_API_KEY not set
#  61  -MetaPipe: all source fetches returned empty output
#  62  -InstallMetaTask: Register-ScheduledTask failed (likely needs admin)
# =============================================================================

# =============================================================================
# HELP
# =============================================================================
function Show-DossierHelp {
    @"
DOSSIER v3 — multi-platform creator-intel pipeline

USAGE:
  Single URL   :  .\dossier.ps1 <url>
  Batch        :  .\dossier.ps1 <urls.txt>
  Watchlist    :  .\dossier.ps1 -Watch <users.txt | user1,user2,...>
  Schedule     :  .\dossier.ps1 -InstallWatchTask -Watch <users.txt> -Time HH:mm
  Update meta  :  .\dossier.ps1 -UpdateMeta
  Show meta    :  .\dossier.ps1 -ShowMeta

PLATFORMS (single + batch):
  Instagram    :  https://www.instagram.com/p/<code>/
                  https://www.instagram.com/reel/<code>/
  TikTok       :  https://www.tiktok.com/@<user>/video/<id>
                  https://vm.tiktok.com/<short>
  YouTube      :  https://www.youtube.com/shorts/<id>
                  https://youtu.be/<id>

FLAGS:
  -Force            Bypass the 24h smart cache and re-scrape
  -NoTour           Skip the auto-Playwright portfolio tour
  -NoRecipe         Skip the auto-recipe synthesis step
  -NoOpen           Don't auto-open index.html at end of run
  -MaxParallel <N>  Parallel jobs in batch mode (default 4)
  -NoNotebookLM     Skip the post-run NotebookLM auto-pipe (v3.1)
  -Notebook <name>  Override notebook name (default: "Creator: @<owner>")
  -AutoPodcast      Generate Audio Overview when notebook source-count hits 5/10/25
  -NoArchive        Skip ARCHIVE updates this run
  -OpenArchive      Open ARCHIVE/index.html in browser after run
  -RebuildArchive   Wipe index.html + SIGNATURES/* (FROM-CLAUDE.md is PRESERVED — append-only history)
  -UpdateMeta            Mode: refresh META.md with current AI/stack/workflow research
  -ShowMeta              Mode: print current META.md to stdout
  -FirecrawlPortfolio    Also Firecrawl-scrape the externalUrl after tour (saves PORTFOLIO-CONTENT.md)
  -VerifyPost <url|code> Mode: extract + verify claims from a post. URL = full pipeline + verify.
                         ShortCode = finds existing dossier folder, skips re-download. Produces VERIFY.md.
  -EchoTest <user>       Mode: write a hypothetical post in <user>'s voice from their signature.
                         Self-validates signature quality. Requires -AnalyzeCreator first (3+ dossiers).
  -MetaPipe              Mode: scrape AI/dev meta sources, diff vs yesterday, verify claims,
                         synthesize META-DAILY-<date>.md. Requires FIRECRAWL_API_KEY for GitHub
                         trending + blog feeds (reddit + HN work without it).
  -InstallMetaTask       Helper: register Windows Scheduled Task for -MetaPipe daily.
                         Use with -Time HH:mm (default 07:00).
  -NoveltyMin <N>        Minimum novelty score (1-10) for MetaPipe items. Default 5.
  -Help             Print this help

OPTIONAL ENVIRONMENT VARIABLES:
  APIFY_TOKEN              Required for all scraping. Prompted on first run if missing.
  ANTHROPIC_API_KEY        Optional. Unlocks Invoke-NativeRecipe / Invoke-NativeTour
                           fallbacks when the claude CLI is unavailable.
  FIRECRAWL_API_KEY        Required for -FirecrawlPortfolio and -UpdateMeta. Prompted
                           on first run if missing.
  WHISPER_MODEL            Required only if whisper.cpp backend is selected. Path to
                           a downloaded GGML model file (e.g., ggml-base.en.bin).

ARTIFACTS PER RUN (under %USERPROFILE%\video-memory\<date>_<user>_<id>\):
  source.mp4, frames\f*.png, audio.{aac,wav}, manifest.json
  BRIEF.md, index.html
  transcript.{txt,srt}        (if Whisper installed)
  profile.json                (Instagram only)
  PORTFOLIO-TOUR.md           (if claude CLI + externalUrl + !NoTour)
  RECIPE.md                   (if claude CLI + !NoRecipe)
  BRIEF.md "## NotebookLM"    (if claude CLI + notebooklm-mcp + !NoNotebookLM)

ARCHIVE (under %USERPROFILE%\video-memory\ARCHIVE\):
  index.html, SIGNATURES\<user>.md, FROM-CLAUDE.md — auto-updated each run unless -NoArchive
"@ | Write-Host
}

if ($Help) { Show-DossierHelp; exit 0 }

# =============================================================================
# PATH CONSTANTS
# =============================================================================
$Script:VideoMemRoot = Join-Path $env:USERPROFILE 'video-memory'
$Script:WatchCache   = Join-Path $Script:VideoMemRoot '.watchlist-cache.json'

# =============================================================================
# APIFY TOKEN (unchanged from v2 — keeps interactive prompt + persist + 401 retry)
# =============================================================================
function Test-ApifyTokenLooksValid {
    param([string]$Token)
    if (-not $Token) { return $false }
    if ($Token -match 'PASTE') { return $false }
    if ($Token.Length -lt 20) { return $false }
    return $true
}

function Read-ApifyTokenInteractive {
    Write-Host ""
    Write-Host "No valid Apify token found." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Get yours at: https://console.apify.com/account/integrations" -ForegroundColor Cyan
    Write-Host '(Look for "Personal API tokens", click the eye icon to reveal.)' -ForegroundColor Cyan
    Write-Host ""
    # -AsSecureString suppresses on-screen echo so the token can't be captured
    # by terminal scrollback, ShareX, or session recordings. Convert back to
    # plaintext only at the moment we need to set $env:APIFY_TOKEN.
    $secureEntered = Read-Host "Paste your token here" -AsSecureString
    $entered = if ($secureEntered) { ConvertFrom-SecureString -SecureString $secureEntered -AsPlainText } else { '' }
    if ($entered) { $entered = $entered.Trim() }
    if (-not (Test-ApifyTokenLooksValid -Token $entered)) {
        Write-Host ""
        Write-Host "That doesn't look like a valid token (should start with 'apify_api_' and be much longer). Aborting." -ForegroundColor Red
        Write-Host ""
        exit 2
    }
    $env:APIFY_TOKEN = $entered
    Write-Host ""
    $saveAns = Read-Host "Save token for future runs? [Y/n]"
    if (-not $saveAns) { $saveAns = 'Y' }
    if ($saveAns -match '^(y|yes)$') {
        try {
            [System.Environment]::SetEnvironmentVariable("APIFY_TOKEN", $entered, "User")
            Write-Host "Saved. You won't be asked again." -ForegroundColor Green
        }
        catch {
            Write-Host "Could not persist token: $($_.Exception.Message)" -ForegroundColor Yellow
            Write-Host "Using just for this run." -ForegroundColor Yellow
        }
    }
    else {
        Write-Host "OK — using just for this run." -ForegroundColor Cyan
    }
    Write-Host ""
    return $entered
}

function Test-FirecrawlTokenLooksValid {
    param([string]$Token)
    if ([string]::IsNullOrWhiteSpace($Token)) { return $false }
    if ($Token -match 'PASTE') { return $false }
    if ($Token.Length -lt 20) { return $false }
    return $true
}

function Read-FirecrawlTokenInteractive {
    Write-Host ""
    Write-Host "No valid Firecrawl token found." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Get yours at: https://firecrawl.dev/app/api-keys" -ForegroundColor Cyan
    Write-Host "(Free tier exists. Token typically starts with 'fc-')" -ForegroundColor Cyan
    Write-Host ""
    # -AsSecureString: see APIFY token comment for the why.
    $secureEntered = Read-Host "Paste your Firecrawl token here" -AsSecureString
    $entered = if ($secureEntered) { ConvertFrom-SecureString -SecureString $secureEntered -AsPlainText } else { '' }
    $entered = $entered.Trim()
    if (-not (Test-FirecrawlTokenLooksValid $entered)) {
        Write-Host "That doesn't look like a valid Firecrawl token. Aborting." -ForegroundColor Red
        exit 52
    }
    $env:FIRECRAWL_API_KEY = $entered
    Write-Host ""
    $save = Read-Host "Save token for future runs? [Y/n]"
    if ([string]::IsNullOrWhiteSpace($save) -or $save -match '^[Yy]') {
        [System.Environment]::SetEnvironmentVariable("FIRECRAWL_API_KEY", $entered, "User")
        Write-Host "Saved. You won't be asked again." -ForegroundColor Green
    } else {
        Write-Host "OK -- using just for this run." -ForegroundColor Cyan
    }
}

function Test-IsUnauthorized {
    param($ErrorRecord)
    if ($null -eq $ErrorRecord) { return $false }
    $resp = $ErrorRecord.Exception.Response
    if ($resp -and $resp.StatusCode -and ([int]$resp.StatusCode -eq 401)) { return $true }
    if ($ErrorRecord.Exception.Message -match '\b401\b|Unauthorized') { return $true }
    return $false
}

# =============================================================================
# PLATFORM DETECTION
# =============================================================================
# Returns a hashtable: @{ Platform='instagram'|'tiktok'|'youtube'; Id=<shortcode> }
# or $null if no platform matches.
function Get-PlatformInfo {
    param([string]$Url)

    if ($Url -match '^https?://(www\.)?instagram\.com/(p|reel|reels)/([^/?#]+)') {
        return @{ Platform = 'instagram'; Id = $Matches[3] }
    }
    if ($Url -match '^https?://(www\.)?tiktok\.com/@[^/]+/video/(\d+)') {
        return @{ Platform = 'tiktok'; Id = $Matches[2] }
    }
    if ($Url -match '^https?://vm\.tiktok\.com/([^/?#]+)') {
        # vm.tiktok.com short links — use the short code as id (resolution happens on Apify side)
        return @{ Platform = 'tiktok'; Id = $Matches[1] }
    }
    if ($Url -match '^https?://(www\.)?youtube\.com/shorts/([^/?#]+)') {
        return @{ Platform = 'youtube'; Id = $Matches[2] }
    }
    if ($Url -match '^https?://youtu\.be/([^/?#]+)') {
        return @{ Platform = 'youtube'; Id = $Matches[1] }
    }
    return $null
}

# =============================================================================
# CACHE LOOKUP (upgrade D)
# =============================================================================
# Looks for an existing folder under video-memory/ whose name ends with `_<id>`.
# Returns the folder path if cache is fresh (<24h), or $null otherwise.
function Find-CachedDossier {
    param(
        [string]$Id,
        [switch]$Force
    )
    if ($Force) { return $null }
    if (-not (Test-Path $Script:VideoMemRoot)) { return $null }

    # Newest-first so multiple matching folders (e.g., a current -Force run
    # plus a late previous-day run) resolve to the freshest dossier.
    $candidates = Get-ChildItem -Path $Script:VideoMemRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match "_${Id}$" } |
        Sort-Object LastWriteTime -Descending
    foreach ($c in $candidates) {
        $manifest = Join-Path $c.FullName 'manifest.json'
        if (Test-Path $manifest) {
            $age = (Get-Date) - (Get-Item $manifest).LastWriteTime
            if ($age.TotalHours -lt 24) {
                return @{ Path = $c.FullName; AgeHours = [int]$age.TotalHours }
            }
        }
    }
    return $null
}

# =============================================================================
# WHISPER BACKEND DETECTION (unchanged from v2)
# =============================================================================
function Test-PythonModule {
    param([string]$ModuleName)
    $py = Get-Command python -ErrorAction SilentlyContinue
    if (-not $py) { return $false }
    $null = & python -c "import $ModuleName" 2>$null
    return ($LASTEXITCODE -eq 0)
}

function Get-DefaultBrowserExe {
    # Returns full path to first available browser in priority order.
    # Used by auto-open paths to bypass Windows file association.
    # PATH probe first; then known Windows install locations (browsers usually aren't on PATH).
    foreach ($name in @('msedge.exe','chrome.exe','firefox.exe','brave.exe')) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd) { return $cmd.Source }
    }
    $candidates = @(
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
        "$env:ProgramFiles\Mozilla Firefox\firefox.exe",
        "${env:ProgramFiles(x86)}\Mozilla Firefox\firefox.exe",
        "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe",
        "${env:ProgramFiles(x86)}\BraveSoftware\Brave-Browser\Application\brave.exe"
    )
    foreach ($p in $candidates) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

function Get-WhisperBackend {
    if (Test-PythonModule -ModuleName 'faster_whisper') {
        return @{ Backend = 'faster-whisper'; Bin = $null }
    }
    if (Test-PythonModule -ModuleName 'whisper') {
        return @{ Backend = 'openai-whisper'; Bin = $null }
    }
    foreach ($candidate in @('whisper-cli', 'whisper.cpp', 'whisper', 'main')) {
        $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($cmd) {
            if ($candidate -in @('whisper-cli', 'whisper.cpp')) {
                return @{ Backend = 'whisper.cpp'; Bin = $cmd.Source }
            }
            try {
                $help = & $cmd.Source --help 2>&1 | Out-String
                if ($help -match 'whisper\.cpp|ggerganov') {
                    return @{ Backend = 'whisper.cpp'; Bin = $cmd.Source }
                }
            } catch { }
        }
    }
    return @{ Backend = $null; Bin = $null }
}

# =============================================================================
# APIFY CALL HELPER (handles 401-retry-once across all platforms)
# =============================================================================
$Script:ApifyTokenReprompted = $false
function Invoke-ApifyActor {
    param(
        [string]$ActorId,           # e.g. 'apify~instagram-post-scraper'
        [hashtable]$InputBody,
        [int]$TimeoutSec = 300
    )
    $body = $InputBody | ConvertTo-Json -Depth 6 -Compress
    $endpoint = "https://api.apify.com/v2/acts/$ActorId/run-sync-get-dataset-items"
    while ($true) {
        # Send token via Authorization header instead of URL query — URLs get
        # logged by proxies and surface in exception messages.
        $headers = @{ Authorization = "Bearer $env:APIFY_TOKEN" }
        try {
            return Invoke-RestMethod -Uri $endpoint -Method Post -Body $body -ContentType 'application/json' -Headers $headers -TimeoutSec $TimeoutSec
        }
        catch {
            if ((Test-IsUnauthorized -ErrorRecord $_) -and -not $Script:ApifyTokenReprompted) {
                Write-Host ""
                Write-Host "Apify rejected the token (401). It may be expired or revoked." -ForegroundColor Red
                $Script:ApifyTokenReprompted = $true
                [void](Read-ApifyTokenInteractive)
                continue
            }
            throw
        }
    }
}

# =============================================================================
# PLATFORM SCRAPERS — each returns a normalized hashtable:
#   @{
#     ownerUsername  = '...'
#     videoUrl       = 'https://...'
#     displayUrl     = 'https://...'
#     caption        = '...'
#     shortCode      = '...'        # the platform-native id
#     timestamp      = '...'
#     likesCount     = N
#     videoViewCount = N
#     commentsCount  = N
#     platform       = 'instagram'|'tiktok'|'youtube'
#     localFile      = $null   # set if we already downloaded (yt-dlp path)
#   }
# =============================================================================

function Get-InstagramPost {
    param([string]$Url)
    $items = Invoke-ApifyActor -ActorId 'apify~instagram-post-scraper' -InputBody @{
        username        = @($Url)
        dataDetailLevel = 'detailedData'
    }
    if (-not $items -or $items.Count -eq 0) {
        throw "Apify returned no items for $Url. The post may be private, deleted, or geo-blocked."
    }
    $p = $items[0]
    if (-not $p.shortCode -or -not $p.ownerUsername) {
        throw "Instagram response missing required fields (shortCode/ownerUsername)."
    }
    if (-not $p.videoUrl) {
        throw "Post has no videoUrl (image-only post?)."
    }
    return @{
        platform       = 'instagram'
        ownerUsername  = $p.ownerUsername
        videoUrl       = $p.videoUrl
        displayUrl     = $p.displayUrl
        caption        = if ($p.caption) { [string]$p.caption } else { '' }
        shortCode      = $p.shortCode
        timestamp      = $p.timestamp
        likesCount     = $p.likesCount
        videoViewCount = $p.videoViewCount
        commentsCount  = $p.commentsCount
        localFile      = $null
    }
}

function Get-TikTokPost {
    # Uses clockworks/tiktok-scraper (~87K users — most widely used TikTok actor on Apify Store).
    # Input field is `postURLs` (per the actor's input schema).
    param([string]$Url)
    $items = Invoke-ApifyActor -ActorId 'clockworks~tiktok-scraper' -InputBody @{
        postURLs                = @($Url)
        shouldDownloadVideos    = $false   # we'll grab the URL ourselves
        shouldDownloadCovers    = $false
        shouldDownloadSubtitles = $false
        resultsPerPage          = 1
    }
    if (-not $items -or $items.Count -eq 0) {
        throw "TikTok scraper returned no items for $Url."
    }
    $p = $items[0]
    # Field names normalized across common TikTok actors:
    $vid = $p.id
    if (-not $vid) { $vid = $p.videoMeta.id }
    if (-not $vid) { $vid = ($Url -replace '.*video/(\d+).*', '$1') }
    $author = if ($p.authorMeta.name) { $p.authorMeta.name }
              elseif ($p.author.uniqueId) { $p.author.uniqueId }
              else { 'unknown' }
    $videoDl = if ($p.videoMeta.downloadAddr) { $p.videoMeta.downloadAddr }
               elseif ($p.video.downloadAddr) { $p.video.downloadAddr }
               elseif ($p.videoUrl) { $p.videoUrl }
               elseif ($p.mediaUrls -and $p.mediaUrls.Count -gt 0) { $p.mediaUrls[0] }
               else { $null }
    if (-not $videoDl) {
        throw "TikTok scraper response had no downloadable video URL. Inspect the raw item."
    }
    return @{
        platform       = 'tiktok'
        ownerUsername  = $author
        videoUrl       = $videoDl
        displayUrl     = $p.videoMeta.coverUrl
        caption        = if ($p.text) { [string]$p.text } else { '' }
        shortCode      = $vid
        timestamp      = $p.createTimeISO
        likesCount     = $p.diggCount
        videoViewCount = $p.playCount
        commentsCount  = $p.commentCount
        localFile      = $null
    }
}

function Get-YouTubeShort {
    # Prefer yt-dlp locally — it's free, fast, and avoids Apify costs.
    # Fallback: streamers/youtube-scraper on Apify.
    param(
        [string]$Url,
        [string]$DownloadPath
    )
    $ytdlp = Get-Command yt-dlp -ErrorAction SilentlyContinue
    if ($ytdlp) {
        Write-Host "       Using yt-dlp (local) for YouTube" -ForegroundColor DarkGray
        # First, fetch JSON metadata
        $metaJson = & yt-dlp -j --no-warnings $Url 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $metaJson) {
            throw "yt-dlp metadata fetch failed for $Url"
        }
        $meta = $metaJson | ConvertFrom-Json
        # Then download to the requested path
        & yt-dlp -f 'mp4/best' -o $DownloadPath --no-warnings $Url *>&1 | Out-Null
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path $DownloadPath)) {
            throw "yt-dlp download failed for $Url"
        }
        return @{
            platform       = 'youtube'
            ownerUsername  = if ($meta.uploader_id) { ($meta.uploader_id -replace '^@','') } elseif ($meta.uploader) { $meta.uploader } else { 'unknown' }
            videoUrl       = $Url   # original; not a direct CDN URL since we already saved
            displayUrl     = $meta.thumbnail
            caption        = $meta.description
            shortCode      = $meta.id
            timestamp      = $meta.upload_date
            likesCount     = $meta.like_count
            videoViewCount = $meta.view_count
            commentsCount  = $meta.comment_count
            localFile      = $DownloadPath   # already downloaded — caller can skip download step
        }
    }

    # Apify fallback
    Write-Host "       yt-dlp not found — falling back to Apify (streamers/youtube-scraper)" -ForegroundColor DarkGray
    $items = Invoke-ApifyActor -ActorId 'streamers~youtube-scraper' -InputBody @{
        startUrls    = @(@{ url = $Url })
        maxResults   = 1
    }
    if (-not $items -or $items.Count -eq 0) {
        throw "YouTube scraper returned no items for $Url."
    }
    $p = $items[0]
    $vid = if ($p.id) { $p.id } elseif ($p.videoId) { $p.videoId } else { ($Url -replace '.*[/=]([\w-]{11}).*', '$1') }
    $videoDl = $p.videoUrl
    if (-not $videoDl -and $p.formats) {
        # streamers/youtube-scraper sometimes nests formats; pick the first mp4
        $videoDl = ($p.formats | Where-Object { $_.url -and $_.ext -eq 'mp4' } | Select-Object -First 1).url
    }
    if (-not $videoDl) {
        throw "YouTube scraper response had no downloadable URL. Install yt-dlp for reliable YT support."
    }
    return @{
        platform       = 'youtube'
        ownerUsername  = $p.channelName
        videoUrl       = $videoDl
        displayUrl     = $p.thumbnailUrl
        caption        = $p.text
        shortCode      = $vid
        timestamp      = $p.date
        likesCount     = $p.likes
        videoViewCount = $p.viewCount
        commentsCount  = $p.commentsCount
        localFile      = $null
    }
}

# =============================================================================
# NOTEBOOKLM AUTO-PIPE (v3.1 Feature A)
# =============================================================================
# v3.1 Feature B — THE ARCHIVE
#   Get-ArchiveDossierData : walk video-memory/ and collect manifest+recipe data
#   Append-FromClaude       : append a date-stamped reflection to FROM-CLAUDE.md
#   Update-CreatorSignature : (re)generate ARCHIVE/SIGNATURES/<user>.md (3+ posts)
#   Update-Archive          : orchestrator called by the pipeline
#   Build-ArchiveIndex      : (re)build ARCHIVE/index.html — creator cards + tag-pill filter
# =============================================================================
function Get-ArchiveDossierData {
    [CmdletBinding()]
    param()
    # Walk every <date>_<user>_<id> folder under $Script:VideoMemRoot
    # For each, read manifest.json, grep RECIPE.md for technique tags
    # Return array of [pscustomobject] with: Username, ShortCode, Folder, PostUrl, PostedAt, FetchedAt, Caption, Tags (array), HasTranscript (bool), HasRecipe (bool), HasNotebookLM (bool with URL if yes)

    $results = @()
    if (-not (Test-Path $Script:VideoMemRoot)) { return $results }

    $folders = Get-ChildItem -Path $Script:VideoMemRoot -Directory -ErrorAction SilentlyContinue |
               Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}_' }

    foreach ($f in $folders) {
        $manifestPath = Join-Path $f.FullName 'manifest.json'
        if (-not (Test-Path $manifestPath)) { continue }
        try {
            $m = Get-Content $manifestPath -Raw | ConvertFrom-Json
        } catch { continue }

        # Extract technique tags from RECIPE.md
        $tags = @()
        $recipePath = Join-Path $f.FullName 'RECIPE.md'
        if (Test-Path $recipePath) {
            $recipeText = Get-Content $recipePath -Raw -ErrorAction SilentlyContinue
            $techPatterns = @('Three\.js', 'React Three Fiber', 'R3F', 'GSAP', 'Lenis', 'Spline', 'Framer Motion', 'Scroll-scrub', 'Particles?', 'Shader', 'WebGL', 'Lottie', 'Tailwind', 'Next\.js', 'Vite', 'mix-blend-mode', 'glass\s*morphism')
            foreach ($p in $techPatterns) {
                if ($recipeText -match $p) {
                    $tags += ($Matches[0] -replace '\\\.','.')
                }
            }
            $tags = $tags | Select-Object -Unique
        }

        $results += [pscustomobject]@{
            Username       = $m.owner_username
            ShortCode      = $m.shortCode
            Folder         = $f.FullName
            FolderName     = $f.Name
            PostUrl        = $m.post_url
            PostedAt       = $m.timestamp
            FetchedAt      = $m.fetched_at
            Caption        = ($m.caption -as [string])
            Tags           = $tags
            HasTranscript  = (Test-Path (Join-Path $f.FullName 'transcript.txt'))
            HasRecipe      = (Test-Path $recipePath)
            HasNotebookLM  = ([bool]$m.notebooklm_url)
            NotebookLMUrl  = $m.notebooklm_url
            BuildsOn       = if ($m.PSObject.Properties.Name -contains 'builds_on' -and $m.builds_on) { @($m.builds_on) } else { @() }
        }
    }
    return $results
}

function Append-FromClaude {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$DossierFolder,
        [Parameter(Mandatory)][string]$Username,
        [Parameter(Mandatory)][string]$ShortCode
    )

    $claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
    if (-not $claudeCmd) {
        Write-Host "  [from-claude] claude CLI not found — skipping commentary" -ForegroundColor Yellow
        return
    }

    $archiveDir = Join-Path $Script:VideoMemRoot 'ARCHIVE'
    $fromClaudePath = Join-Path $archiveDir 'FROM-CLAUDE.md'

    # Initialize file with header if missing
    if (-not (Test-Path $fromClaudePath)) {
        New-Item -ItemType Directory -Path $archiveDir -Force | Out-Null
        $header = @"
# Running notes from Claude after each dossier

These are observations, not analysis. Personal first-person reflections from the AI after each dossier run. Date-stamped, append-only, never re-generated.

---

"@
        Set-Content -Path $fromClaudePath -Value $header -Encoding UTF8
    }

    $prompt = @"
You just produced a dossier on @$Username's post $ShortCode. Read BRIEF.md, RECIPE.md, and (if exists) transcript.txt at $DossierFolder. APPEND a single short paragraph (3-6 sentences) to $fromClaudePath as honest first-person reflection on what struck you about THIS specific creator/post. NOT analysis — observation. Have an opinion. Have personality. Format: a date stamp line (## $(Get-Date -Format 'yyyy-MM-dd') — @$Username / $ShortCode), then the paragraph below it. NEVER use bullet points. NEVER use generic phrases like 'this creator demonstrates' or 'overall, this content showcases.' Make each entry feel like a hand-written note from a librarian who just finished reading the material.
"@

    try {
        $output = & claude -p $prompt --add-dir $Script:VideoMemRoot 2>&1
        if ($LASTEXITCODE -ne 0) {
            $output = & claude --dangerously-skip-permissions -p $prompt --add-dir $Script:VideoMemRoot 2>&1
        }
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  [from-claude] commentary appended" -ForegroundColor Green
        } else {
            Write-Host "  [from-claude] claude CLI exited non-zero — skipping" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "  [from-claude] failed: $_" -ForegroundColor Yellow
    }
}

function Update-CreatorSignature {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Username)

    $claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
    if (-not $claudeCmd) {
        return  # Silent skip — already warned in Append-FromClaude
    }

    # Get all dossiers for this username
    $allData = Get-ArchiveDossierData
    $userDossiers = $allData | Where-Object { $_.Username -eq $Username }

    if ($userDossiers.Count -lt 3) {
        return  # Silent — need 3+ for a meaningful signature
    }

    $archiveDir = Join-Path $Script:VideoMemRoot 'ARCHIVE'
    $sigDir = Join-Path $archiveDir 'SIGNATURES'
    New-Item -ItemType Directory -Path $sigDir -Force | Out-Null
    $sigPath = Join-Path $sigDir "$Username.md"

    # Build folder list for the prompt
    $folderList = ($userDossiers | ForEach-Object { $_.Folder }) -join "`n"

    $prompt = @"
You are synthesizing a creator signature file. There are $($userDossiers.Count) dossiers for @$Username. For each dossier folder below, read its BRIEF.md and RECIPE.md (if present), then write a synthesis to $sigPath with these sections:

# Signature — @$Username

_$($userDossiers.Count) posts analyzed_

## Consistent Patterns
What @$Username does across nearly every post. Concrete techniques, framings, structural moves.

## Evolution Trajectory
How their work has shifted across the timeline. Earliest to latest.

## Distinctive Signature
The 1-2 things that make their work instantly recognizable. The thing they own.

## Notable Absences
What they DON'T do that you'd expect a creator in this lane to do. Restraint or gap.

Dossier folders to read:
$folderList

OVERWRITE $sigPath with the result. Be specific, not generic. Quote phrasings if useful. No bullet-list dumps — paragraphs that read.
"@

    try {
        $output = & claude -p $prompt --add-dir $Script:VideoMemRoot 2>&1
        if ($LASTEXITCODE -ne 0) {
            $output = & claude --dangerously-skip-permissions -p $prompt --add-dir $Script:VideoMemRoot 2>&1
        }
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  [signature] @$Username updated ($($userDossiers.Count) posts)" -ForegroundColor Green
        } else {
            Write-Host "  [signature] @$Username — claude CLI failed, skipping" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "  [signature] @$Username failed: $_" -ForegroundColor Yellow
    }
}

function Update-Archive {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$DossierFolder,
        [Parameter(Mandatory)][string]$OwnerUsername,
        [Parameter(Mandatory)][string]$ShortCode,
        [switch]$RebuildArchive
    )

    $archiveDir = Join-Path $Script:VideoMemRoot 'ARCHIVE'
    New-Item -ItemType Directory -Path $archiveDir -Force | Out-Null

    if ($RebuildArchive) {
        Write-Host "  [archive] -RebuildArchive: wiping index.html + SIGNATURES/* (FROM-CLAUDE.md PRESERVED)" -ForegroundColor Yellow
        $indexPath = Join-Path $archiveDir 'index.html'
        if (Test-Path $indexPath) { Remove-Item $indexPath -Force }
        $sigDir = Join-Path $archiveDir 'SIGNATURES'
        if (Test-Path $sigDir) { Remove-Item $sigDir -Recurse -Force }
    }

    # Always regenerate index.html (no claude CLI required)
    Build-ArchiveIndex -ArchiveDir $archiveDir

    # Append running commentary (claude CLI required, soft-skip if missing)
    Append-FromClaude -DossierFolder $DossierFolder -Username $OwnerUsername -ShortCode $ShortCode

    # Regenerate signature for this user (claude CLI required, only if 3+ dossiers)
    Update-CreatorSignature -Username $OwnerUsername
}

function Build-ArchiveIndex {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$ArchiveDir)

    $indexPath = Join-Path $ArchiveDir 'index.html'
    $fromClaudePath = Join-Path $ArchiveDir 'FROM-CLAUDE.md'
    $now = Get-Date
    $generatedStamp = $now.ToString('yyyy-MM-dd HH:mm')

    # ---------- HTML helpers ----------
    function Format-HtmlEscape([string]$s) {
        if ($null -eq $s) { return '' }
        return ($s -replace '&','&amp;' -replace '<','&lt;' -replace '>','&gt;' -replace '"','&quot;' -replace "'",'&#39;')
    }
    function Format-RelativeTime([datetime]$then, [datetime]$nowRef) {
        $delta = $nowRef - $then
        if ($delta.TotalSeconds -lt 60) { return 'just now' }
        if ($delta.TotalMinutes -lt 60) { $n = [int]$delta.TotalMinutes; return "$n minute$(if ($n -eq 1) { '' } else { 's' }) ago" }
        if ($delta.TotalHours -lt 24)   { $n = [int]$delta.TotalHours;   return "$n hour$(if ($n -eq 1) { '' } else { 's' }) ago" }
        if ($delta.TotalDays -lt 30)    { $n = [int]$delta.TotalDays;    return "$n day$(if ($n -eq 1) { '' } else { 's' }) ago" }
        if ($delta.TotalDays -lt 365)   { $n = [int]($delta.TotalDays / 30); return "$n month$(if ($n -eq 1) { '' } else { 's' }) ago" }
        $n = [int]($delta.TotalDays / 365)
        return "$n year$(if ($n -eq 1) { '' } else { 's' }) ago"
    }
    function Format-FileUrl([string]$path) {
        if (-not $path) { return '' }
        $abs = $path -replace '\\','/'
        if ($abs -notmatch '^[A-Za-z]:/') { return ('file:///' + $abs) }
        return ('file:///' + $abs)
    }
    function Format-TagSlug([string]$tag) {
        return ($tag.ToLower() -replace '[^a-z0-9]+','-').Trim('-')
    }

    # ---------- Pull data ----------
    $data = Get-ArchiveDossierData

    # ---------- Empty state ----------
    if (-not $data -or $data.Count -eq 0) {
        $emptyHtml = @"
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DOSSIER Archive</title>
<style>
  :root { --bg:#0a0a0a; --fg:#e8e8e8; --accent:#6ee7b7; --border:#222; --dim:#888; }
  *,*::before,*::after { box-sizing:border-box; }
  html,body { margin:0; padding:0; background:var(--bg); color:var(--fg); }
  body { min-height:100vh; display:flex; align-items:center; justify-content:center; font-family:'Inter', system-ui, sans-serif; padding:4rem 1.5rem; }
  .empty { text-align:center; max-width:560px; }
  .empty h1 { font-family:'JetBrains Mono', monospace; font-size:2rem; letter-spacing:.04em; margin:0 0 1rem; color:var(--accent); }
  .empty p { color:var(--dim); font-size:1rem; line-height:1.6; margin:0; }
  code { font-family:'JetBrains Mono', monospace; color:var(--accent); background:#111; padding:.15em .4em; border:1px solid var(--border); border-radius:4px; }
</style>
</head>
<body>
  <div class="empty">
    <h1>DOSSIER ARCHIVE</h1>
    <p>No dossiers yet — run <code>.\dossier.ps1 &lt;url&gt;</code> to start the archive.</p>
    <p style="margin-top:1.5rem; font-size:.8rem;">Generated $generatedStamp</p>
  </div>
</body>
</html>
"@
        $emptyHtml | Out-File -FilePath $indexPath -Encoding UTF8 -NoNewline
        Write-Host "  [archive] index written (empty state) to $indexPath" -ForegroundColor Cyan
        return
    }

    # ---------- Aggregate ----------
    $totalPosts = $data.Count
    $creatorMap = @{}
    $allTags = @{}
    foreach ($d in $data) {
        $u = $d.Username
        if (-not $u) { $u = '(unknown)' }
        if (-not $creatorMap.ContainsKey($u)) {
            $creatorMap[$u] = @{ Username = $u; Posts = @(); TagCounts = @{} }
        }
        $creatorMap[$u].Posts += $d
        foreach ($t in @($d.Tags)) {
            if (-not $t) { continue }
            $tt = "$t"
            if (-not $creatorMap[$u].TagCounts.ContainsKey($tt)) { $creatorMap[$u].TagCounts[$tt] = 0 }
            $creatorMap[$u].TagCounts[$tt] += 1
            if (-not $allTags.ContainsKey($tt)) { $allTags[$tt] = 0 }
            $allTags[$tt] += 1
        }
    }
    $totalCreators = $creatorMap.Keys.Count
    $distinctTags = $allTags.Keys.Count
    $sortedTags = $allTags.Keys | Sort-Object { -$allTags[$_] }, { $_ }

    # ---------- Hero stats ----------
    $heroLine = "$totalCreators creator$(if ($totalCreators -eq 1) { '' } else { 's' }) &middot; $totalPosts post$(if ($totalPosts -eq 1) { '' } else { 's' }) &middot; $distinctTags distinct technique$(if ($distinctTags -eq 1) { '' } else { 's' }) &middot; last updated $generatedStamp"

    # ---------- Tag pills HTML ----------
    $pillsSb = [System.Text.StringBuilder]::new()
    [void]$pillsSb.Append('<button class="pill pill-all is-active" data-tag-all type="button">All</button>')
    foreach ($t in $sortedTags) {
        $slug = Format-TagSlug $t
        $count = $allTags[$t]
        $label = Format-HtmlEscape $t
        [void]$pillsSb.Append("<button class=`"pill`" data-tag=`"$slug`" type=`"button`">$label <span class=`"pill-count`">$count</span></button>")
    }
    $pillsHtml = $pillsSb.ToString()

    # ---------- Creator cards ----------
    $cardsSb = [System.Text.StringBuilder]::new()
    $sortedCreators = $creatorMap.Keys | Sort-Object {
        $posts = $creatorMap[$_].Posts
        $latest = ($posts | Sort-Object -Property PostedAt -Descending | Select-Object -First 1).PostedAt
        if ($latest) { -([datetime]$latest).Ticks } else { 0 }
    }
    foreach ($u in $sortedCreators) {
        $entry = $creatorMap[$u]
        $posts = $entry.Posts
        $postCount = $posts.Count
        $latestPost = $posts | Sort-Object -Property PostedAt -Descending | Select-Object -First 1
        $latestRel = ''
        $latestAbs = ''
        if ($latestPost.PostedAt) {
            try {
                $dt = [datetime]$latestPost.PostedAt
                $latestRel = Format-RelativeTime -then $dt -nowRef $now
                $latestAbs = $dt.ToString('yyyy-MM-dd')
            } catch {
                $latestRel = "$($latestPost.PostedAt)"
                $latestAbs = "$($latestPost.PostedAt)"
            }
        }
        $top3 = $entry.TagCounts.GetEnumerator() | Sort-Object -Property Value -Descending | Select-Object -First 3
        $tagSlugs = @()
        $chipsSb = [System.Text.StringBuilder]::new()
        foreach ($kv in $top3) {
            $slug = Format-TagSlug $kv.Key
            $tagSlugs += $slug
            $chipsSb.AppendFormat('<span class="chip">{0}</span>', (Format-HtmlEscape $kv.Key)) | Out-Null
        }
        # Card needs ALL tags for the creator (so AND-filter on any combo works)
        $allCardSlugs = @()
        foreach ($t in $entry.TagCounts.Keys) { $allCardSlugs += (Format-TagSlug $t) }
        $dataTagsAttr = ($allCardSlugs | Select-Object -Unique) -join ','
        $folderUrl = Format-FileUrl $latestPost.Folder
        $userEsc = Format-HtmlEscape $u
        # Collect builds_on refs across this creator's posts for the card extends-badge.
        # Cap at 2 visible to keep card height stable; deeper history surfaces in the Lineage section.
        $allBuildsOn = @()
        foreach ($p in $posts) { if ($p.BuildsOn) { $allBuildsOn += @($p.BuildsOn) } }
        $allBuildsOn = @($allBuildsOn | Select-Object -Unique)
        $extendsBadgeHtml = ''
        if ($allBuildsOn.Count -gt 0) {
            $extendsBadgeSb = [System.Text.StringBuilder]::new()
            foreach ($ref in ($allBuildsOn | Select-Object -First 2)) {
                $extendsBadgeSb.AppendFormat('<span class="extends-badge" title="extends {0}">&#8599; {0}</span>', (Format-HtmlEscape $ref)) | Out-Null
            }
            $extendsBadgeHtml = '<div class="card-extends">' + $extendsBadgeSb.ToString() + '</div>'
        }
        [void]$cardsSb.AppendFormat(@'
<a class="card" href="{0}" data-tags="{1}">
  <div class="card-head">
    <span class="card-user">@{2}</span>
    <span class="card-count">{3} post{4}</span>
  </div>
  <div class="card-meta">
    <span class="card-rel" title="{6}">{5}</span>
  </div>
  <div class="card-chips">{7}</div>
  {8}
</a>
'@,
            $folderUrl,
            $dataTagsAttr,
            $userEsc,
            $postCount,
            $(if ($postCount -eq 1) { '' } else { 's' }),
            (Format-HtmlEscape $latestRel),
            (Format-HtmlEscape $latestAbs),
            $chipsSb.ToString(),
            $extendsBadgeHtml
        )
    }
    $cardsHtml = $cardsSb.ToString()

    # ---------- Recent activity (last 10) ----------
    $recent = $data | Sort-Object -Property PostedAt -Descending | Select-Object -First 10
    $rowsSb = [System.Text.StringBuilder]::new()
    foreach ($r in $recent) {
        $dateStr = ''
        try {
            if ($r.PostedAt) { $dateStr = ([datetime]$r.PostedAt).ToString('yyyy-MM-dd') }
        } catch { $dateStr = "$($r.PostedAt)" }
        $rowSlugs = @()
        foreach ($t in @($r.Tags)) { if ($t) { $rowSlugs += (Format-TagSlug $t) } }
        $rowDataTags = ($rowSlugs | Select-Object -Unique) -join ','
        $chipsRowSb = [System.Text.StringBuilder]::new()
        foreach ($t in @($r.Tags) | Select-Object -First 4) {
            if ($t) { $chipsRowSb.AppendFormat('<span class="chip chip-mini">{0}</span>', (Format-HtmlEscape $t)) | Out-Null }
        }
        $rowUrl = Format-FileUrl $r.Folder
        [void]$rowsSb.AppendFormat(@'
<a class="row" href="{0}" data-tags="{1}">
  <span class="row-date">{2}</span>
  <span class="row-user">@{3}</span>
  <span class="row-shortcode">{4}</span>
  <span class="row-chips">{5}</span>
</a>
'@,
            $rowUrl,
            $rowDataTags,
            (Format-HtmlEscape $dateStr),
            (Format-HtmlEscape $r.Username),
            (Format-HtmlEscape $r.ShortCode),
            $chipsRowSb.ToString()
        )
    }
    $rowsHtml = $rowsSb.ToString()

    # ---------- Untagged dossier audit ----------
    # Surface dossiers where the 17-pattern regex extracted ZERO technique tags.
    # These are either tag-vocabulary gaps (creator uses something we don't pattern)
    # or weak recipes (claude didn't surface enough stack-tags). Either way: action item.
    $untaggedItems = $data | Where-Object { -not $_.Tags -or @($_.Tags).Count -eq 0 }
    $untaggedCount = @($untaggedItems).Count
    $auditSection = ''
    if ($untaggedCount -gt 0) {
        $auditSb = [System.Text.StringBuilder]::new()
        foreach ($u in ($untaggedItems | Sort-Object -Property PostedAt -Descending)) {
            $uUrl  = Format-FileUrl $u.Folder
            $uUser = Format-HtmlEscape $u.Username
            $uCode = Format-HtmlEscape $u.ShortCode
            [void]$auditSb.AppendFormat(
                '<a class="audit-row" href="{0}"><span class="audit-user">@{1}</span><span class="audit-code">{2}</span></a>',
                $uUrl, $uUser, $uCode
            )
        }
        $auditRowsHtml = $auditSb.ToString()
        $auditSection = @"
    <section aria-label="Untagged dossiers">
      <div class="section-head">
        <h2>Untagged audit</h2>
        <span class="meta">$untaggedCount post$(if ($untaggedCount -eq 1) { '' } else { 's' }) with zero detected technique tags</span>
      </div>
      <div class="audit-section">
        <div class="audit-list">$auditRowsHtml</div>
      </div>
    </section>
"@
    }

    # ---------- Lineage edges ----------
    # Build a list of (from-dossier -> to-ref) edges for the Lineage section render.
    $lineageEdges = @()
    foreach ($d in $data) {
        if ($d.BuildsOn -and @($d.BuildsOn).Count -gt 0) {
            foreach ($ref in $d.BuildsOn) {
                $lineageEdges += [pscustomobject]@{
                    FromUser = $d.Username
                    FromSC   = $d.ShortCode
                    FromUrl  = Format-FileUrl $d.Folder
                    ToRef    = $ref
                }
            }
        }
    }
    $lineageSection = ''
    if ($lineageEdges.Count -gt 0) {
        $lSb = [System.Text.StringBuilder]::new()
        foreach ($e in $lineageEdges) {
            $fromEsc = Format-HtmlEscape "@$($e.FromUser)/$($e.FromSC)"
            $toEsc   = Format-HtmlEscape $e.ToRef
            [void]$lSb.AppendFormat(
                '<div class="lineage-row"><a class="lineage-from" href="{0}">{1}</a><span class="lineage-arrow">extends</span><span class="lineage-to">{2}</span></div>',
                $e.FromUrl, $fromEsc, $toEsc
            )
        }
        $lineageRowsHtml = $lSb.ToString()
        $edgeCount = $lineageEdges.Count
        $lineageSection = @"
    <section aria-label="Recipe lineage">
      <div class="section-head">
        <h2>Lineage</h2>
        <span class="meta">$edgeCount connection$(if ($edgeCount -eq 1) { '' } else { 's' }) found in archive</span>
      </div>
      <div class="lineage-list">$lineageRowsHtml</div>
    </section>
"@
    }

    # ---------- Footer ----------
    $fromClaudeUrl = Format-FileUrl $fromClaudePath
    $fromClaudeExists = Test-Path $fromClaudePath
    $footerLink = if ($fromClaudeExists) {
        "<a href=`"$fromClaudeUrl`">$(Format-HtmlEscape $fromClaudePath)</a>"
    } else {
        "<span class=`"missing`">$(Format-HtmlEscape $fromClaudePath) (not yet created)</span>"
    }

    # ---------- Compose document ----------
    $html = @"
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DOSSIER Archive</title>
<style>
  :root {
    --bg:#0a0a0a; --fg:#e8e8e8; --accent:#6ee7b7; --border:#222; --dim:#888;
    --mono:'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
    --sans:'Inter', system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  }
  *,*::before,*::after { box-sizing:border-box; }
  html,body { margin:0; padding:0; background:var(--bg); color:var(--fg); }
  body { font-family:var(--sans); line-height:1.5; -webkit-font-smoothing:antialiased; }
  a { color:inherit; text-decoration:none; }
  .wrap { max-width:1200px; margin:0 auto; padding:3rem 1.5rem 4rem; }

  /* HERO */
  .hero { padding:2.5rem 0 2rem; border-bottom:1px solid var(--border); margin-bottom:2rem; }
  .hero h1 { font-family:var(--mono); font-size:clamp(2rem, 5vw, 3.25rem); margin:0 0 .9rem; letter-spacing:.04em; font-weight:700; }
  .hero h1 span { color:var(--accent); }
  .hero-stats { font-family:var(--mono); color:var(--dim); font-size:.95rem; letter-spacing:.02em; }

  /* PILLS */
  .pills-wrap { margin:0 0 2.5rem; }
  .pills-label { font-family:var(--mono); font-size:.7rem; color:var(--dim); letter-spacing:.18em; text-transform:uppercase; margin:0 0 .75rem; }
  .pills { display:flex; flex-wrap:wrap; gap:.5rem; }
  .pill {
    font-family:var(--mono); font-size:.78rem; letter-spacing:.02em;
    background:transparent; color:var(--fg); border:1px solid var(--border);
    padding:.4rem .85rem; border-radius:999px; cursor:pointer;
    transition:background-color 150ms ease, color 150ms ease, border-color 150ms ease;
  }
  .pill:hover { border-color:var(--accent); color:var(--accent); }
  .pill.is-active { background:var(--accent); color:#062b1d; border-color:var(--accent); }
  .pill.is-active .pill-count { color:#062b1d; opacity:.8; }
  .pill-count { color:var(--dim); margin-left:.4rem; font-size:.7rem; }

  /* SECTION HEADERS */
  .section-head { display:flex; align-items:baseline; justify-content:space-between; margin:0 0 1.25rem; gap:1rem; flex-wrap:wrap; }
  .section-head h2 { font-family:var(--mono); font-size:.9rem; letter-spacing:.18em; text-transform:uppercase; margin:0; color:var(--fg); }
  .section-head .meta { font-family:var(--mono); font-size:.72rem; color:var(--dim); }

  /* CREATOR GRID */
  .grid { display:grid; gap:1rem; grid-template-columns:repeat(auto-fill, minmax(280px, 1fr)); margin-bottom:3.5rem; }
  .card {
    display:flex; flex-direction:column; gap:.7rem;
    border:1px solid var(--border); padding:1.25rem 1.25rem 1.1rem;
    border-radius:6px; background:#0d0d0d;
    transition:border-color 150ms ease, transform 150ms ease, opacity 150ms ease, background-color 150ms ease;
  }
  .card:hover { border-color:var(--accent); background:#101412; transform:translateY(-1px); }
  .card-head { display:flex; align-items:baseline; justify-content:space-between; gap:.5rem; }
  .card-user { font-family:var(--mono); font-size:1.05rem; font-weight:700; letter-spacing:.01em; color:var(--fg); }
  .card-count { font-family:var(--mono); font-size:.72rem; color:var(--dim); }
  .card-meta { font-family:var(--mono); font-size:.78rem; color:var(--dim); }
  .card-rel { color:var(--accent); }
  .card-chips { display:flex; flex-wrap:wrap; gap:.35rem; margin-top:.1rem; }

  .chip {
    font-family:var(--mono); font-size:.68rem; letter-spacing:.02em;
    color:var(--accent); border:1px solid #1a3a2c; background:#0c1612;
    padding:.18rem .55rem; border-radius:3px;
  }
  .chip-mini { font-size:.62rem; padding:.12rem .45rem; }

  /* ACTIVITY */
  .activity { display:flex; flex-direction:column; border:1px solid var(--border); border-radius:6px; overflow:hidden; }
  .row {
    display:grid; grid-template-columns: 110px 160px 110px 1fr;
    gap:1rem; align-items:center;
    padding:.8rem 1rem; border-bottom:1px solid var(--border);
    transition:background-color 150ms ease, opacity 150ms ease;
    font-family:var(--mono); font-size:.82rem;
  }
  .row:last-child { border-bottom:none; }
  .row:hover { background:#101412; }
  .row-date { color:var(--dim); font-size:.78rem; }
  .row-user { color:var(--accent); font-weight:600; }
  .row-shortcode { color:var(--fg); }
  .row-chips { display:flex; gap:.3rem; flex-wrap:wrap; justify-content:flex-end; }
  @media (max-width:640px) {
    .row { grid-template-columns: 90px 1fr; row-gap:.3rem; }
    .row-shortcode, .row-chips { grid-column: 1 / -1; }
  }

  /* HIDDEN BY FILTER */
  .is-hidden { display:none !important; }

  /* LINEAGE */
  .card-extends { display:flex; flex-wrap:wrap; gap:.3rem; margin-top:.15rem; }
  .extends-badge {
    font-family:var(--mono); font-size:.62rem; letter-spacing:.02em;
    color:#a78bfa; border:1px solid #2d1f5e; background:#12102a;
    padding:.12rem .45rem; border-radius:3px;
  }
  .lineage-list { display:flex; flex-direction:column; gap:.5rem; margin-top:.75rem; padding:1.25rem 1.5rem; border:1px solid var(--border); border-radius:6px; background:#0d0d0d; }
  .lineage-row { font-family:var(--mono); font-size:.82rem; display:flex; align-items:center; gap:.75rem; flex-wrap:wrap; }
  .lineage-from { color:var(--accent); font-weight:600; }
  .lineage-from:hover { text-decoration:underline; }
  .lineage-arrow { color:var(--dim); font-size:.7rem; letter-spacing:.08em; text-transform:uppercase; }
  .lineage-to { color:#a78bfa; }

  /* UNTAGGED AUDIT */
  .audit-section { padding: 1.25rem 1.5rem; border:1px solid var(--border); border-radius:6px; background:#0d0d0d; }
  .audit-list { display:flex; flex-direction:column; gap:.4rem; }
  .audit-row { display:flex; gap:1rem; padding:.5rem .75rem; border-radius:4px; background:#101212; font-family:var(--mono); font-size:.78rem; transition:background-color 150ms ease, color 150ms ease; }
  .audit-row:hover { background:#162018; color:var(--accent); }
  .audit-user { color:var(--accent); font-weight:600; }
  .audit-code { color:var(--dim); }

  /* FOOTER */
  footer { margin-top:3.5rem; padding-top:1.5rem; border-top:1px solid var(--border); font-family:var(--mono); font-size:.72rem; color:var(--dim); display:flex; flex-direction:column; gap:.4rem; }
  footer a { color:var(--accent); }
  footer a:hover { text-decoration:underline; }
  footer .missing { color:#666; font-style:italic; }
</style>
</head>
<body>
  <main class="wrap">
    <header class="hero">
      <h1><span>DOSSIER</span> ARCHIVE</h1>
      <div class="hero-stats">$heroLine</div>
    </header>

    <section class="pills-wrap" aria-label="Tag filters">
      <p class="pills-label">Filter by technique &mdash; AND logic</p>
      <div class="pills" id="pills">
        $pillsHtml
      </div>
    </section>

    <section aria-label="Creators">
      <div class="section-head">
        <h2>Creators</h2>
        <span class="meta" id="creator-meta">$totalCreators shown</span>
      </div>
      <div class="grid" id="creator-grid">
        $cardsHtml
      </div>
    </section>

    <section aria-label="Recent activity">
      <div class="section-head">
        <h2>Recent activity</h2>
        <span class="meta" id="activity-meta">last 10</span>
      </div>
      <div class="activity" id="activity-feed">
        $rowsHtml
      </div>
    </section>

$lineageSection

$auditSection

    <footer>
      <div>DOSSIER v3.1 &middot; auto-regenerated each run</div>
      <div>FROM-CLAUDE.md exists at $footerLink</div>
    </footer>
  </main>

<script>
(function(){
  const pillsRoot = document.getElementById('pills');
  const grid = document.getElementById('creator-grid');
  const feed = document.getElementById('activity-feed');
  const creatorMeta = document.getElementById('creator-meta');
  const activityMeta = document.getElementById('activity-meta');
  if (!pillsRoot) return;

  const active = new Set();

  function tagsOf(el) {
    const raw = (el.getAttribute('data-tags') || '').trim();
    if (!raw) return [];
    return raw.split(',').filter(Boolean);
  }

  function applyFilter() {
    const required = Array.from(active);
    const cards = grid ? grid.querySelectorAll('.card') : [];
    let cardShown = 0;
    cards.forEach(c => {
      const t = tagsOf(c);
      const ok = required.length === 0 || required.every(r => t.includes(r));
      c.classList.toggle('is-hidden', !ok);
      if (ok) cardShown++;
    });
    if (creatorMeta) {
      creatorMeta.textContent = required.length === 0
        ? cardShown + ' shown'
        : cardShown + ' shown (filtered)';
    }
    const rows = feed ? feed.querySelectorAll('.row') : [];
    let rowShown = 0;
    rows.forEach(r => {
      const t = tagsOf(r);
      const ok = required.length === 0 || required.every(rr => t.includes(rr));
      r.classList.toggle('is-hidden', !ok);
      if (ok) rowShown++;
    });
    if (activityMeta) {
      activityMeta.textContent = required.length === 0
        ? 'last 10'
        : rowShown + ' of last 10';
    }
  }

  pillsRoot.addEventListener('click', (e) => {
    const btn = e.target.closest('.pill');
    if (!btn) return;
    if (btn.hasAttribute('data-tag-all')) {
      active.clear();
      pillsRoot.querySelectorAll('.pill').forEach(p => p.classList.remove('is-active'));
      btn.classList.add('is-active');
      applyFilter();
      return;
    }
    const tag = btn.getAttribute('data-tag');
    if (!tag) return;
    if (active.has(tag)) {
      active.delete(tag);
      btn.classList.remove('is-active');
    } else {
      active.add(tag);
      btn.classList.add('is-active');
    }
    const allBtn = pillsRoot.querySelector('[data-tag-all]');
    if (allBtn) allBtn.classList.toggle('is-active', active.size === 0);
    applyFilter();
  });
})();
</script>
</body>
</html>
"@

    $html | Out-File -FilePath $indexPath -Encoding UTF8 -NoNewline
    Write-Host "  [archive] index.html rendered ($totalCreators creators, $totalPosts posts, $distinctTags tags)" -ForegroundColor Cyan
}

# =============================================================================
# Pipes the just-finished dossier into NotebookLM via the `claude` CLI calling
# the notebooklm-mcp tools (notebook_list / notebook_create / source_add /
# studio_create). Adds three sources per dossier:
#   - Transcript - <shortcode>  (text content of transcript.txt, skipped if missing)
#   - Brief - <shortcode>       (text content of BRIEF.md)
#   - Recipe - <shortcode>      (text content of RECIPE.md, skipped if missing)
#
# Default notebook name is "Creator: @<ownerUsername>" so every dossier from the
# same creator funnels into the same notebook. Pass -Notebook <name> to override
# (useful for grouping by topic/project rather than creator).
#
# Returns a hashtable: @{ ok=$true/$false; notebookUrl=<string>; podcastId=<string> }
# Soft-fails on every failure mode — never throws.
# =============================================================================
function Invoke-NotebookLMPipe {
    param(
        [string]$OutDir,
        [string]$OwnerUsername,
        [string]$ShortCode,
        [string]$NotebookName,        # if blank, derives "Creator: @<owner>"
        [bool]$AutoPodcast,
        [string]$BriefMd,
        [string]$RecipeMd,
        [string]$TranscriptTxt
    )

    $result = @{ ok = $false; notebookUrl = $null; podcastId = $null }

    # 1. claude CLI must be on PATH
    $claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
    if (-not $claudeCmd) {
        Write-Host "       (claude CLI not on PATH; skipping NotebookLM auto-pipe)" -ForegroundColor DarkGray
        return $result
    }

    # 1b. nlm doctor auth check — soft-fail if NotebookLM is not authenticated.
    #     `nlm doctor` checks cookies and other state; we look for 'Cookies: present' in the output.
    #     We do a 10-second timeout to avoid blocking the pipeline on a missing/broken nlm install.
    #     Resolve nlm.exe path in parent process so the Start-Job subprocess (which doesn't inherit
    #     mid-session PATH modifications) can still find it via explicit path.
    $nlmExe = (Get-Command nlm -ErrorAction SilentlyContinue).Source
    if ($nlmExe) {
        $nlmJob = Start-Job -ArgumentList $nlmExe -ScriptBlock {
            param($nlmExe)
            $output = & $nlmExe doctor 2>&1
            [PSCustomObject]@{ Output = $output; ExitCode = $LASTEXITCODE }
        }
        $completed = Wait-Job -Job $nlmJob -Timeout 10
        if (-not $completed) {
            Stop-Job -Job $nlmJob
            Remove-Job -Job $nlmJob -Force
            Write-Warning "nlm doctor timed out after 10s; skipping NotebookLM auto-pipe."
            return $result
        }
        $nlmResult = Receive-Job -Job $nlmJob
        Remove-Job -Job $nlmJob
        $doctorText = ($nlmResult.Output | Out-String)
        # Strip ANSI CSI escape sequences (color codes, e.g. \e[32m, \e[0m, \e[1;31m) so the
        # regex isn't broken by color codes injected between 'Cookies:' and 'present'.
        $doctorText = $doctorText -replace "$([char]27)\[[0-9;]*[a-zA-Z]", ''
        if ($doctorText -notmatch 'Cookies:\s*present') {
            Write-Warning "NotebookLM auth check (nlm doctor) didn't see 'Cookies: present' — auth may be expired or doctor output changed."
            Write-Warning "Run 'nlm login' in an interactive terminal to refresh auth, then re-run dossier."
            Write-Warning "Skipping NotebookLM auto-pipe for this run."
            return $result
        }
        Write-Host "       NotebookLM auth OK (nlm doctor confirmed cookies present)" -ForegroundColor DarkGray
    } else {
        Write-Host "       (nlm CLI not on PATH; skipping NotebookLM auth check)" -ForegroundColor DarkGray
    }

    # 2. Settle the target notebook name
    if (-not $NotebookName) { $NotebookName = "Creator: @$OwnerUsername" }

    # 3. Decide which sources we have
    $haveTranscript = $TranscriptTxt -and (Test-Path $TranscriptTxt)
    $haveBrief      = $BriefMd       -and (Test-Path $BriefMd)
    $haveRecipe     = $RecipeMd      -and (Test-Path $RecipeMd)
    if (-not $haveBrief) {
        Write-Warning "BRIEF.md missing; skipping NotebookLM auto-pipe."
        return $result
    }

    # 4. Build the prompt for claude. We ask it to output a single JSON line on
    #    the LAST line of stdout: {"notebook_url":"...","source_count":N,"podcast_id":"..."}
    #    so we can parse without touching the conversation log.
    $autoPodcastJson = if ($AutoPodcast) { 'true' } else { 'false' }
    $transcriptArg = if ($haveTranscript) { $TranscriptTxt } else { '' }
    $recipeArg     = if ($haveRecipe)     { $RecipeMd }      else { '' }

    $prompt = @"
You are piping a fresh dossier into NotebookLM via the notebooklm-mcp tools.

Inputs for this run:
  notebook_name: $NotebookName
  shortcode:     $ShortCode
  owner:         @$OwnerUsername
  brief_path:    $BriefMd
  recipe_path:   $recipeArg     (empty = skip)
  transcript_path: $transcriptArg (empty = skip)
  auto_podcast:  $autoPodcastJson

Steps (do them in this exact order — do not skip):

1. Call mcp__notebooklm-mcp__notebook_list to look for an existing notebook
   whose title equals "$NotebookName" (exact match, case-sensitive). If it
   exists, capture its notebook_id. If it does not, call
   mcp__notebooklm-mcp__notebook_create with title="$NotebookName" and capture
   the new notebook_id.

2. For each of the three input files that is non-empty AND exists, read its
   content from the local filesystem (you have file-read access) then call
   mcp__notebooklm-mcp__source_add with:
     - notebook_id: <captured>
     - source_type: "text"
     - title:       one of "Transcript - $ShortCode", "Brief - $ShortCode",
                    or "Recipe - $ShortCode"
     - text:        the file content (UTF-8). For transcript and brief the
                    raw content is fine. For recipe the raw markdown is fine.

   Skip any file whose path is empty or that does not exist.

3. After all source_add calls succeed, call mcp__notebooklm-mcp__notebook_get
   (or notebook_describe — whichever returns a source count) to read the
   notebook's current total source count. Capture this as source_count.

4. Capture the notebook URL. Most notebook_get responses include either a
   "url" or "notebook_url" field. If only the notebook_id is returned,
   construct: https://notebooklm.google.com/notebook/<notebook_id>

5. If auto_podcast is "true" AND source_count is in {5, 10, 25}, also call
   mcp__notebooklm-mcp__studio_create with:
     - notebook_id:   <captured>
     - artifact_type: "audio"
   and capture the returned artifact_id (or studio_id) as podcast_id.
   If source_count is not a threshold, do not create an artifact.

6. As your VERY LAST line of stdout, print exactly one JSON object with this
   shape (no trailing newline / no surrounding prose):
     {"notebook_url":"<url>","source_count":<int>,"podcast_id":"<id-or-empty>"}

   This last-line JSON is the only thing the calling script parses.
"@

    Write-Host "       Calling claude CLI to drive notebooklm-mcp ..." -ForegroundColor DarkGray
    $nlmLog = Join-Path $OutDir 'claude-notebooklm.log'
    Set-Content -Path $nlmLog -Value '=== claude -p --dangerously-skip-permissions --model claude-sonnet-4-6 ===' -Encoding utf8
    try {
        $stdout = $prompt | & claude --dangerously-skip-permissions --model claude-sonnet-4-6 -p --add-dir $Script:VideoMemRoot 2>&1
        Add-Content -Path $nlmLog -Value $stdout -Encoding utf8
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "claude CLI failed on NotebookLM step (exit $LASTEXITCODE). Continuing."
            return $result
        }
    } catch {
        Write-Warning "claude CLI threw on NotebookLM step: $($_.Exception.Message). Continuing."
        return $result
    }

    # 5. Parse the last JSON line out of stdout. claude streams ANSI + chatter
    #    above it; we only care about the final {"notebook_url":...} line.
    $stdoutText = ($stdout | Out-String)
    $lines = $stdoutText -split "`r?`n" | Where-Object { $_ -match '^\s*\{.*"notebook_url".*\}\s*$' }
    if (-not $lines -or $lines.Count -eq 0) {
        Write-Warning "NotebookLM step ran but no parseable JSON line was returned. Continuing."
        return $result
    }
    $jsonLine = [string]($lines | Select-Object -Last 1).Trim()
    try {
        $parsed = $jsonLine | ConvertFrom-Json -ErrorAction Stop
    } catch {
        Write-Warning "Could not parse NotebookLM JSON output: $jsonLine"
        return $result
    }

    $url    = $parsed.notebook_url
    $count  = $parsed.source_count
    $podId  = $parsed.podcast_id
    if (-not $url) {
        Write-Warning "NotebookLM JSON had empty notebook_url. Continuing."
        return $result
    }

    Write-Host "       Notebook URL: $url" -ForegroundColor DarkGray
    if ($count) { Write-Host "       Notebook source count: $count" -ForegroundColor DarkGray }
    if ($podId) { Write-Host "       Audio Overview queued: $podId" -ForegroundColor Green }

    $result.ok          = $true
    $result.notebookUrl = $url
    $result.podcastId   = $podId
    return $result
}

# =============================================================================
# VERIFY-POST V1 — CLAIMS EXTRACTION
# Given a dossier folder, reads transcript.txt + BRIEF.md, calls claude CLI to
# emit structured JSON enumerating all claims. Returns a hashtable:
#   { ok=$true/false; claims=@{repos;libraries;mcp_servers;models;specific_claims}; claimsJson='...' }
# =============================================================================
function Invoke-VerifyPostClaims {
    param(
        [string]$DossierFolder,
        [string]$TranscriptTxt,
        [string]$BriefMd
    )

    $result = @{ ok = $false; claims = $null; claimsJson = '' }

    # Build source text
    $parts = [System.Collections.Generic.List[string]]::new()
    if ($TranscriptTxt -and (Test-Path $TranscriptTxt)) {
        $raw = Get-Content $TranscriptTxt -Raw -Encoding utf8
        if ($raw.Length -gt 12000) { $raw = $raw.Substring(0, 12000) + "`n[... truncated ...]" }
        $parts.Add("## TRANSCRIPT`n$raw")
    }
    if ($BriefMd -and (Test-Path $BriefMd)) {
        $brief = Get-Content $BriefMd -Raw -Encoding utf8
        if ($brief.Length -gt 4000) { $brief = $brief.Substring(0, 4000) + "`n[... truncated ...]" }
        $parts.Add("## BRIEF.md`n$brief")
    }
    if ($parts.Count -eq 0) {
        Write-Warning "[verify-v1] No transcript or BRIEF.md found in $DossierFolder"
        return $result
    }

    $sourcesText = $parts -join "`n`n---`n`n"

    $prompt = @"
You are analyzing a social-media post transcript to extract ALL technical claims made.
The creator claims to have found/built/used specific tools, repos, libraries, models, or techniques.

Extract every claim into this exact JSON structure (emit ONLY the JSON block, no prose before or after):

``````json
{
  "repos": [
    { "name": "<owner/repo or plain name>", "url": "<github url if mentioned>", "claim": "<what was claimed about it>" }
  ],
  "libraries": [
    { "name": "<package name>", "ecosystem": "npm|pypi|cargo|other", "claim": "<what was claimed>" }
  ],
  "mcp_servers": [
    { "name": "<server name>", "url": "<url if mentioned>", "claim": "<what was claimed>" }
  ],
  "models": [
    { "name": "<model name>", "provider": "<provider if known>", "claim": "<what was claimed>" }
  ],
  "specific_claims": [
    { "claim": "<any other specific verifiable claim not covered above>", "type": "feature|performance|pricing|availability|other" }
  ]
}
``````

Rules:
- Include a claim even if you're not sure it's real. The next stage verifies.
- If a category has no claims, use an empty array [].
- Do not invent claims not in the source text.
- One JSON block only, no commentary.

SOURCE CONTENT:
$sourcesText
"@

    $claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
    if ($claudeCmd) {
        Write-Host "  [verify-v1] Extracting claims via claude CLI ..." -ForegroundColor DarkGray
        $claimsLog = Join-Path $DossierFolder 'claude-verify-v1.log'
        try {
            $stdout = $prompt | & claude --dangerously-skip-permissions --model claude-sonnet-4-6 -p --add-dir $Script:VideoMemRoot 2>&1
            Set-Content -Path $claimsLog -Value ($stdout | Out-String) -Encoding utf8
            if ($LASTEXITCODE -ne 0) {
                Write-Warning "[verify-v1] claude CLI exited $LASTEXITCODE"
                return $result
            }
        } catch {
            Write-Warning "[verify-v1] claude CLI threw: $($_.Exception.Message)"
            return $result
        }
    } else {
        Write-Host "  [verify-v1] claude CLI not found; trying native fallback ..." -ForegroundColor DarkGray
        $stdout = Invoke-NativeClaimsExtract -Prompt $prompt -DossierFolder $DossierFolder
        if (-not $stdout) { return $result }
    }

    # Parse JSON from fenced block
    $stdoutText = if ($stdout -is [array]) { $stdout -join "`n" } else { [string]$stdout }
    $jsonMatch = [regex]::Match($stdoutText, '(?s)```json\s*(\{.*?\})\s*```')
    if (-not $jsonMatch.Success) {
        # Fallback: try bare JSON object
        $jsonMatch = [regex]::Match($stdoutText, '(?s)(\{[^`]*"repos"[^`]*\})')
    }
    if (-not $jsonMatch.Success) {
        Write-Warning "[verify-v1] Could not find JSON block in claims output"
        return $result
    }

    $jsonStr = $jsonMatch.Groups[1].Value.Trim()
    try {
        $claims = $jsonStr | ConvertFrom-Json -ErrorAction Stop
    } catch {
        Write-Warning "[verify-v1] Could not parse claims JSON: $($_.Exception.Message)"
        return $result
    }

    $result.ok         = $true
    $result.claims     = $claims
    $result.claimsJson = $jsonStr
    return $result
}

# =============================================================================
# VERIFY-POST V1 NATIVE FALLBACK — calls Anthropic API directly when claude CLI
# is absent. Returns stdout string or $null on failure.
# =============================================================================
function Invoke-NativeClaimsExtract {
    param(
        [string]$Prompt,
        [string]$DossierFolder
    )

    if (-not $env:ANTHROPIC_API_KEY) {
        Write-Host "       (ANTHROPIC_API_KEY not set; cannot run native claims extraction)" -ForegroundColor DarkGray
        return $null
    }
    $pyCmd = Get-Command python -ErrorAction SilentlyContinue
    if (-not $pyCmd) {
        Write-Host "       (python not on PATH; cannot run native claims extraction)" -ForegroundColor DarkGray
        return $null
    }

    $pyScript = @'
import sys, os, json, urllib.request, urllib.error

api_key = os.environ.get('ANTHROPIC_API_KEY', '')
if not api_key:
    print('[native-claims] ANTHROPIC_API_KEY not set', file=sys.stderr)
    sys.exit(1)

prompt_text = sys.stdin.read()
payload = {
    'model': 'claude-sonnet-4-6',
    'max_tokens': 2048,
    'messages': [{'role': 'user', 'content': prompt_text}]
}
data = json.dumps(payload).encode('utf-8')
req = urllib.request.Request(
    'https://api.anthropic.com/v1/messages',
    data=data,
    headers={
        'x-api-key': api_key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
    },
    method='POST'
)
try:
    with urllib.request.urlopen(req, timeout=90) as resp:
        body = json.loads(resp.read().decode('utf-8'))
        print(body['content'][0]['text'])
except urllib.error.HTTPError as e:
    print(f'[native-claims] HTTP {e.code}: {e.read().decode()}', file=sys.stderr)
    sys.exit(1)
'@

    $pyTempFile = Join-Path $env:TEMP "dossier-claims-$(Get-Random).py"
    try {
        Set-Content -Path $pyTempFile -Value $pyScript -Encoding utf8
        $stdout = $Prompt | & python $pyTempFile 2>&1
        if ($LASTEXITCODE -eq 0) { return ($stdout | Out-String) }
        Write-Warning "[native-claims] python exited $LASTEXITCODE"
        return $null
    } catch {
        Write-Warning "[native-claims] threw: $($_.Exception.Message)"
        return $null
    } finally {
        if (Test-Path $pyTempFile) { Remove-Item $pyTempFile -Force -ErrorAction SilentlyContinue }
    }
}

# =============================================================================
# VERIFY-POST V2 — PER-CLAIM VERIFICATION ORCHESTRATOR
# Takes the claims hashtable from V1. Runs parallel Start-Job checks: GitHub
# repo existence/stars/last-push, npm/pypi package version, HuggingFace model
# lookup. Returns @{ results = @(...) } where each item has:
#   { type; name; originalClaim; found; stars; lastPush; latestVersion;
#     deprecated; readmeSummary; notes }
# =============================================================================
function Invoke-VerifyPostCheck {
    param(
        [PSCustomObject]$Claims    # output of Invoke-VerifyPostClaims .claims
    )

    $checkItems = [System.Collections.Generic.List[hashtable]]::new()

    # Flatten all claims into a single list of check items.
    # Plain hashtables (not PSCustomObjects) so Start-Job CLIXML serialization is clean.
    foreach ($r in $Claims.repos) {
        $checkItems.Add(@{ type='repo'; name=$r.name; url=$r.url; originalClaim=$r.claim })
    }
    foreach ($l in $Claims.libraries) {
        $checkItems.Add(@{ type='library'; name=$l.name; ecosystem=$l.ecosystem; originalClaim=$l.claim })
    }
    foreach ($m in $Claims.mcp_servers) {
        $checkItems.Add(@{ type='mcp_server'; name=$m.name; url=$m.url; originalClaim=$m.claim })
    }
    foreach ($mo in $Claims.models) {
        $checkItems.Add(@{ type='model'; name=$mo.name; provider=$mo.provider; originalClaim=$mo.claim })
    }

    if ($checkItems.Count -eq 0) {
        return @{ results = @() }
    }

    Write-Host "  [verify-v2] Checking $($checkItems.Count) claim(s) in parallel ..." -ForegroundColor DarkGray

    # Spawn one Start-Job per claim item
    $jobs = [System.Collections.Generic.List[hashtable]]::new()
    foreach ($item in $checkItems) {
        $j = Start-Job -ArgumentList $item -ScriptBlock {
            param($ci)
            $out = @{
                type          = $ci.type
                name          = $ci.name
                originalClaim = $ci.originalClaim
                found         = $false
                stars         = $null
                lastPush      = $null
                latestVersion = $null
                deprecated    = $null
                readmeSummary = ''
                notes         = ''
            }

            $ghToken = $env:GITHUB_TOKEN
            $ghHeaders = if ($ghToken) {
                @{ Authorization = "Bearer $ghToken"; 'User-Agent' = 'dossier-verify/1.0' }
            } else {
                @{ 'User-Agent' = 'dossier-verify/1.0' }
            }

            try {
                switch ($ci.type) {
                    'repo' {
                        # Try to extract owner/repo from name or url
                        $repoSlug = $null
                        if ($ci.url -match 'github\.com/([^/?#]+/[^/?#]+)') {
                            $repoSlug = $Matches[1] -replace '\.git$',''
                        } elseif ($ci.name -match '^[^/]+/[^/]+$') {
                            $repoSlug = $ci.name
                        }
                        if ($repoSlug) {
                            $apiUrl = "https://api.github.com/repos/$repoSlug"
                            $resp = Invoke-RestMethod -Uri $apiUrl -Headers $ghHeaders -TimeoutSec 15 -ErrorAction Stop
                            $out.found    = $true
                            $out.stars    = $resp.stargazers_count
                            $out.lastPush = $resp.pushed_at
                            $out.notes    = "Repo exists. Stars: $($resp.stargazers_count). Last push: $($resp.pushed_at). Description: $($resp.description)"
                        } else {
                            $out.notes = "Could not parse a github.com/owner/repo slug from name='$($ci.name)' url='$($ci.url)'"
                        }
                    }
                    'library' {
                        switch ($ci.ecosystem) {
                            'npm' {
                                $resp = Invoke-RestMethod -Uri "https://registry.npmjs.org/$($ci.name)/latest" -TimeoutSec 15 -ErrorAction Stop
                                $out.found         = $true
                                $out.latestVersion = $resp.version
                                $out.deprecated    = [bool]$resp.deprecated
                                $out.notes         = "npm: v$($resp.version). Deprecated: $($out.deprecated)."
                            }
                            'pypi' {
                                $resp = Invoke-RestMethod -Uri "https://pypi.org/pypi/$($ci.name)/json" -TimeoutSec 15 -ErrorAction Stop
                                $out.found         = $true
                                $out.latestVersion = $resp.info.version
                                $out.deprecated    = ($resp.info.classifiers -contains 'Development Status :: 7 - Inactive')
                                $out.notes         = "PyPI: v$($resp.info.version). Deprecated: $($out.deprecated)."
                            }
                            default {
                                # Try npm first as the most common ecosystem
                                try {
                                    $resp = Invoke-RestMethod -Uri "https://registry.npmjs.org/$($ci.name)/latest" -TimeoutSec 10 -ErrorAction Stop
                                    $out.found         = $true
                                    $out.latestVersion = $resp.version
                                    $out.deprecated    = [bool]$resp.deprecated
                                    $out.notes         = "npm (ecosystem unknown, tried npm): v$($resp.version)."
                                } catch {
                                    $out.notes = "ecosystem='$($ci.ecosystem)' - no automated check. Verify manually."
                                }
                            }
                        }
                    }
                    'mcp_server' {
                        # MCP servers: try GitHub slug parse first
                        $repoSlug = $null
                        if ($ci.url -match 'github\.com/([^/?#]+/[^/?#]+)') {
                            $repoSlug = $Matches[1] -replace '\.git$',''
                        }
                        if ($repoSlug) {
                            try {
                                $resp = Invoke-RestMethod -Uri "https://api.github.com/repos/$repoSlug" -Headers $ghHeaders -TimeoutSec 15 -ErrorAction Stop
                                $out.found    = $true
                                $out.stars    = $resp.stargazers_count
                                $out.lastPush = $resp.pushed_at
                                $out.notes    = "GitHub MCP: $repoSlug - stars=$($resp.stargazers_count), last push=$($resp.pushed_at)"
                            } catch {
                                $out.notes = "GitHub lookup failed for $repoSlug : $_"
                            }
                        } else {
                            $out.notes = "No GitHub URL found for MCP server '$($ci.name)'. Verify manually."
                        }
                    }
                    'model' {
                        # HuggingFace check for open models; for proprietary (OpenAI/Anthropic/Google) just note
                        $knownProviders = @('openai','anthropic','google','meta','mistral','cohere')
                        $provLower = if ($ci.provider) { $ci.provider.ToLower() } else { '' }
                        $isProprietary = $false
                        foreach ($p in $knownProviders) { if ($provLower -match $p) { $isProprietary = $true; break } }
                        if ($isProprietary) {
                            $out.notes = "Proprietary model ($($ci.provider) / $($ci.name)) - cannot programmatically verify; check provider docs."
                            $out.found = $true  # assume known-provider models exist as claimed
                        } else {
                            # Try HuggingFace
                            $hfName = $ci.name -replace '\s+', '-'
                            try {
                                $resp = Invoke-RestMethod -Uri "https://huggingface.co/api/models/$hfName" -TimeoutSec 15 -ErrorAction Stop
                                $out.found = $true
                                $out.notes = "HuggingFace: $($resp.modelId) - downloads=$($resp.downloads), likes=$($resp.likes)"
                            } catch {
                                $out.notes = "HuggingFace lookup failed for '$hfName': $_"
                            }
                        }
                    }
                }
            } catch {
                $out.notes = "Check threw: $_"
            }
            return $out
        }
        $jobs.Add(@{ job = $j; item = $item })
    }

    Wait-Job -Job ($jobs | ForEach-Object { $_.job }) | Out-Null

    $results = [System.Collections.Generic.List[hashtable]]::new()
    foreach ($jh in $jobs) {
        try {
            $r = Receive-Job -Job $jh.job -ErrorAction SilentlyContinue
            if ($r) {
                $results.Add($r)
            } else {
                $results.Add(@{ type=$jh.item.type; name=$jh.item.name; found=$false; notes='Job returned no output' })
            }
        } catch {
            $results.Add(@{ type=$jh.item.type; name=$jh.item.name; found=$false; notes="Receive-Job threw: $_" })
        } finally {
            Remove-Job -Job $jh.job -Force -ErrorAction SilentlyContinue
        }
    }

    return @{ results = $results }
}

# =============================================================================
# VERIFY-POST V3 — PERSONALIZED SYNTHESIS
# Combines V1 claims JSON + V2 verification results into VERIFY.md.
# Reads META.md at runtime so the synthesis uses Alex's current stack research
# rather than a hardcoded stack reference (which would go stale).
# Returns $true if VERIFY.md was produced, $false otherwise.
# =============================================================================
function Invoke-VerifyPostSynth {
    param(
        [string]$DossierFolder,
        [string]$ClaimsJson,
        [string]$VerifyResultsJson,
        [string]$VerifyMd
    )

    # Read META.md for stack context (Alex's Lucac LLC research)
    $metaPath = Join-Path $Script:VideoMemRoot 'META.md'
    $metaContent = if (Test-Path $metaPath) {
        $raw = Get-Content $metaPath -Raw -Encoding utf8
        if ($raw.Length -gt 16000) { $raw.Substring(0, 16000) + "`n[... META.md truncated ...]" } else { $raw }
    } else {
        "(META.md not present at $metaPath - synthesize using general best-fit recommendations; flag the missing context in the output.)"
    }

    $prompt = @"
You are helping Alex (Lucac LLC, solo founder, construction-to-tech pivot,
building tools for his pool-industry business plus broader operations).

His current stack and tooling research is captured in META.md below.
Use this as the source of truth for what "his stack" means.

## META.md (Alex's stack research)

$metaContent

---

You have:
1. CLAIMS JSON - what a social-media post claimed about tools, repos, libraries, models
2. VERIFICATION JSON - automated checks: github existence, stars, last push,
   npm/pypi version, HuggingFace presence

Write VERIFY.md to the dossier folder at: $DossierFolder

VERIFY.md must have exactly these sections:

# VERIFY - Post Claim Audit

_Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm')_

## Real?

For each claim: one-line verdict (CONFIRMED / UNVERIFIED / NOT FOUND / DEPRECATED)
+ one sentence of evidence. Use the verification JSON. Be blunt.

## Get It

For each CONFIRMED item: install/access command (npm install X, pip install Y,
github.com/Z, etc.). Skip anything NOT FOUND or DEPRECATED.

## Try It For Your Stack

For each CONFIRMED item: one concrete suggestion for how Alex could use it,
referencing his actual stack from META.md above. If it doesn't fit at all,
say "Not relevant to your current stack."

## Upgrade for Lucac

Cross-cutting: if two or more claims together unlock a workflow upgrade for
Alex's broader operations (the dossier system, calendar app, anything in
META.md's scope), describe it in 3-5 sentences. If no cross-cutting
opportunity, write "No cross-cutting upgrade identified."

## Skip If...

For each item: one-liner on when/why Alex should skip it entirely
(e.g., "Skip if you're not doing 3D - irrelevant to current pool-app work").

---

CLAIMS JSON:
$ClaimsJson

VERIFICATION JSON:
$VerifyResultsJson

Write the complete VERIFY.md now. No preamble, no explanation - just the markdown.
"@

    $claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
    if ($claudeCmd) {
        Write-Host "  [verify-v3] Synthesizing VERIFY.md via claude CLI ..." -ForegroundColor DarkGray
        $synthLog = Join-Path $DossierFolder 'claude-verify-v3.log'
        $stdout = $null
        try {
            $stdout = $prompt | & claude --dangerously-skip-permissions --model claude-sonnet-4-6 -p --add-dir $Script:VideoMemRoot 2>&1
            Set-Content -Path $synthLog -Value ($stdout | Out-String) -Encoding utf8
            if ($LASTEXITCODE -ne 0) {
                Write-Warning "[verify-v3] claude CLI exited $LASTEXITCODE"
                return $false
            }
        } catch {
            Write-Warning "[verify-v3] claude CLI threw: $($_.Exception.Message)"
            return $false
        }
        # Primary path: claude wrote the file directly via its file-write capability
        if ((Test-Path $VerifyMd) -and ((Get-Item $VerifyMd).Length -gt 200)) {
            $sz = (Get-Item $VerifyMd).Length
            Write-Host "  [verify-v3] VERIFY.md written ($sz bytes)" -ForegroundColor Green
            return $true
        }
        # Defensive fallback: claude emitted markdown to stdout instead of writing the file.
        # Capture stdout and write VERIFY.md ourselves.
        $stdoutText = if ($stdout -is [array]) { $stdout -join "`n" } else { [string]$stdout }
        if ($stdoutText -and $stdoutText.Length -gt 200) {
            $stdoutText | Set-Content -Path $VerifyMd -Encoding utf8
            if ((Test-Path $VerifyMd) -and ((Get-Item $VerifyMd).Length -gt 200)) {
                Write-Host "  [verify-v3] VERIFY.md written from stdout fallback" -ForegroundColor Green
                return $true
            }
        }
        Write-Warning "[verify-v3] claude ran but VERIFY.md not produced or too small. Check $synthLog"
        return $false
    } else {
        Write-Host "  [verify-v3] claude CLI not found; trying native fallback ..." -ForegroundColor DarkGray
        return (Invoke-NativeVerifySynth -Prompt $prompt -VerifyMd $VerifyMd)
    }
}

# =============================================================================
# VERIFY-POST V3 NATIVE FALLBACK — calls Anthropic API when claude CLI absent.
# Writes VERIFY.md directly from API response. Returns $true/$false.
# =============================================================================
function Invoke-NativeVerifySynth {
    param(
        [string]$Prompt,
        [string]$VerifyMd
    )

    if (-not $env:ANTHROPIC_API_KEY) {
        Write-Host "       (ANTHROPIC_API_KEY not set; cannot synthesize VERIFY.md natively)" -ForegroundColor DarkGray
        return $false
    }
    $pyCmd = Get-Command python -ErrorAction SilentlyContinue
    if (-not $pyCmd) {
        Write-Host "       (python not on PATH; cannot synthesize VERIFY.md natively)" -ForegroundColor DarkGray
        return $false
    }

    $pyScript = @'
import sys, os, json, urllib.request, urllib.error

api_key = os.environ.get('ANTHROPIC_API_KEY', '')
out_path = os.environ.get('DOSSIER_VERIFY_PATH', '')
if not api_key:
    print('[native-verify] ANTHROPIC_API_KEY not set', file=sys.stderr); sys.exit(1)
if not out_path:
    print('[native-verify] DOSSIER_VERIFY_PATH not set', file=sys.stderr); sys.exit(1)

prompt_text = sys.stdin.read()
payload = {
    'model': 'claude-sonnet-4-6',
    'max_tokens': 4096,
    'messages': [{'role': 'user', 'content': prompt_text}]
}
data = json.dumps(payload).encode('utf-8')
req = urllib.request.Request(
    'https://api.anthropic.com/v1/messages',
    data=data,
    headers={'x-api-key': api_key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'},
    method='POST'
)
try:
    with urllib.request.urlopen(req, timeout=120) as resp:
        body = json.loads(resp.read().decode('utf-8'))
        text = body['content'][0]['text']
        with open(out_path, 'w', encoding='utf-8') as f:
            f.write(text)
        print(f'[native-verify] VERIFY.md written ({len(text)} bytes)')
except urllib.error.HTTPError as e:
    print(f'[native-verify] HTTP {e.code}: {e.read().decode()}', file=sys.stderr); sys.exit(1)
'@

    $pyTempFile = Join-Path $env:TEMP "dossier-verify-synth-$(Get-Random).py"
    try {
        Set-Content -Path $pyTempFile -Value $pyScript -Encoding utf8
        $env:DOSSIER_VERIFY_PATH = $VerifyMd
        $Prompt | & python $pyTempFile 2>&1 | Out-Host
        if ($LASTEXITCODE -eq 0 -and (Test-Path $VerifyMd) -and ((Get-Item $VerifyMd).Length -gt 200)) {
            return $true
        }
        Write-Warning "[native-verify] python exited $LASTEXITCODE or VERIFY.md not produced."
        return $false
    } catch {
        Write-Warning "[native-verify] threw: $($_.Exception.Message)"
        return $false
    } finally {
        $env:DOSSIER_VERIFY_PATH = $null
        if (Test-Path $pyTempFile) { Remove-Item $pyTempFile -Force -ErrorAction SilentlyContinue }
    }
}

# =============================================================================
# WAVE 3 — DAILY META ROUTINE
# Functions: Invoke-MetaSourceFetch, Invoke-MetaItemExtract,
#            Invoke-NativeMetaExtract, Invoke-MetaDelta, Invoke-MetaVerify,
#            Invoke-MetaSynth, Invoke-NativeMetaSynth, Install-MetaTask
# =============================================================================

# =============================================================================
# META SOURCE FETCH — fetches raw content from each source category IN PARALLEL.
# Returns hashtable @{ reddit; hn; github; blogs } where each is @{ ok; text }.
# Reddit and HN are unauthenticated public APIs. GitHub trending and blog feeds
# use Firecrawl (require FIRECRAWL_API_KEY; skip gracefully if absent).
# =============================================================================
function Invoke-MetaSourceFetch {
    param(
        [string]$FirecrawlKey   # $env:FIRECRAWL_API_KEY passed in; jobs cannot see parent scope
    )

    $fcKey = $FirecrawlKey

    # --- Reddit job (no auth required) ---
    $jReddit = Start-Job -ScriptBlock {
        param($key)
        $subs = @('ClaudeAI', 'LocalLLaMA', 'MachineLearning', 'ChatGPTCoding', 'webdev', 'threejs')
        $out = [System.Collections.Generic.List[string]]::new()
        $headers = @{ 'User-Agent' = 'dossier-meta/1.0' }
        foreach ($sub in $subs) {
            try {
                $uri = "https://www.reddit.com/r/$sub.json?limit=25"
                $resp = Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec 20 -ErrorAction Stop
                $posts = $resp.data.children | ForEach-Object {
                    $d = $_.data
                    "r/$sub | score=$($d.score) | $($d.title) | $($d.url)"
                }
                $out.Add("## r/$sub`n" + ($posts -join "`n"))
            } catch {
                $out.Add("## r/$sub`n(fetch failed: $($_.Exception.Message))")
            }
        }
        return @{ ok = ($out.Count -gt 0); text = ($out -join "`n`n") }
    } -ArgumentList $fcKey

    # --- HN job (Firebase API, no auth) ---
    $jHN = Start-Job -ScriptBlock {
        param($key)
        try {
            $ids = Invoke-RestMethod -Uri 'https://hacker-news.firebaseio.com/v0/topstories.json' -TimeoutSec 20 -ErrorAction Stop
            $top30 = $ids | Select-Object -First 30
            $items = [System.Collections.Generic.List[string]]::new()
            foreach ($id in $top30) {
                try {
                    $item = Invoke-RestMethod -Uri "https://hacker-news.firebaseio.com/v0/item/$id.json" -TimeoutSec 10 -ErrorAction Stop
                    if ($item.type -eq 'story' -and $item.title) {
                        $url = if ($item.url) { $item.url } else { "https://news.ycombinator.com/item?id=$id" }
                        $items.Add("- score=$($item.score) | $($item.title) | $url")
                    }
                } catch { continue }
                if ($items.Count -ge 15) { break }  # cap to keep runtime bounded
            }
            return @{ ok = ($items.Count -gt 0); text = "## Hacker News Top Stories`n" + ($items -join "`n") }
        } catch {
            return @{ ok = $false; text = "## Hacker News`n(fetch failed: $($_.Exception.Message))" }
        }
    } -ArgumentList $fcKey

    # --- GitHub trending job (HTML-only, requires Firecrawl) ---
    $jGitHub = Start-Job -ScriptBlock {
        param($fcKey)
        if ([string]::IsNullOrWhiteSpace($fcKey)) {
            return @{ ok = $false; text = "## GitHub Trending`n(skipped: FIRECRAWL_API_KEY not set)" }
        }
        $langs = @('typescript', 'python', 'javascript')
        $out = [System.Collections.Generic.List[string]]::new()
        $fcHeaders = @{ 'Authorization' = "Bearer $fcKey"; 'Content-Type' = 'application/json' }
        foreach ($lang in $langs) {
            try {
                $fcBody = @{ url = "https://github.com/trending/$lang`?since=daily"; formats = @('markdown') } | ConvertTo-Json
                $fcResp = Invoke-RestMethod -Uri 'https://api.firecrawl.dev/v1/scrape' -Method Post -Headers $fcHeaders -Body $fcBody -TimeoutSec 60 -ErrorAction Stop
                if ($fcResp.data.markdown) {
                    $md = $fcResp.data.markdown
                    if ($md.Length -gt 3000) { $md = $md.Substring(0, 3000) + "`n[... truncated ...]" }
                    $out.Add("## GitHub Trending ($lang)`n$md")
                }
            } catch {
                $out.Add("## GitHub Trending ($lang)`n(fetch failed: $($_.Exception.Message))")
            }
        }
        return @{ ok = ($out.Count -gt 0); text = ($out -join "`n`n") }
    } -ArgumentList $fcKey

    # --- Blog feeds job (requires Firecrawl) ---
    $jBlogs = Start-Job -ScriptBlock {
        param($fcKey)
        if ([string]::IsNullOrWhiteSpace($fcKey)) {
            return @{ ok = $false; text = "## Blog Feeds`n(skipped: FIRECRAWL_API_KEY not set)" }
        }
        $feeds = @(
            @{ name = 'Anthropic News'; url = 'https://www.anthropic.com/news' },
            @{ name = 'Vercel Blog';    url = 'https://vercel.com/blog' },
            @{ name = 'OpenAI Blog';    url = 'https://openai.com/blog' }
        )
        $out = [System.Collections.Generic.List[string]]::new()
        $fcHeaders = @{ 'Authorization' = "Bearer $fcKey"; 'Content-Type' = 'application/json' }
        foreach ($feed in $feeds) {
            try {
                $fcBody = @{ url = $feed.url; formats = @('markdown') } | ConvertTo-Json
                $fcResp = Invoke-RestMethod -Uri 'https://api.firecrawl.dev/v1/scrape' -Method Post -Headers $fcHeaders -Body $fcBody -TimeoutSec 60 -ErrorAction Stop
                if ($fcResp.data.markdown) {
                    $md = $fcResp.data.markdown
                    if ($md.Length -gt 4000) { $md = $md.Substring(0, 4000) + "`n[... truncated ...]" }
                    $out.Add("## $($feed.name)`n$md")
                }
            } catch {
                $out.Add("## $($feed.name)`n(fetch failed: $($_.Exception.Message))")
            }
        }
        return @{ ok = ($out.Count -gt 0); text = ($out -join "`n`n") }
    } -ArgumentList $fcKey

    Write-Host "  [meta-m1] Waiting for source fetches (reddit, HN, GitHub, blogs)..." -ForegroundColor DarkGray
    Wait-Job -Job @($jReddit, $jHN, $jGitHub, $jBlogs) -Timeout 150 | Out-Null

    $rReddit = try { Receive-Job $jReddit -ErrorAction SilentlyContinue } catch { @{ ok=$false; text='(receive error)' } }
    $rHN     = try { Receive-Job $jHN -ErrorAction SilentlyContinue }     catch { @{ ok=$false; text='(receive error)' } }
    $rGitHub = try { Receive-Job $jGitHub -ErrorAction SilentlyContinue } catch { @{ ok=$false; text='(receive error)' } }
    $rBlogs  = try { Receive-Job $jBlogs -ErrorAction SilentlyContinue }  catch { @{ ok=$false; text='(receive error)' } }

    Remove-Job -Job @($jReddit, $jHN, $jGitHub, $jBlogs) -Force -ErrorAction SilentlyContinue

    return @{
        reddit = if ($rReddit) { $rReddit } else { @{ ok=$false; text='(no output)' } }
        hn     = if ($rHN)     { $rHN }     else { @{ ok=$false; text='(no output)' } }
        github = if ($rGitHub) { $rGitHub } else { @{ ok=$false; text='(no output)' } }
        blogs  = if ($rBlogs)  { $rBlogs }  else { @{ ok=$false; text='(no output)' } }
    }
}

# =============================================================================
# META ITEM EXTRACT — sends each source's raw text to claude (one call per
# category) with a structured-JSON extraction prompt. Returns flat list of
# @{ category; title; url; summary; sourceClaim; novelty } filtered by NoveltyMin.
# =============================================================================
function Invoke-MetaItemExtract {
    param(
        [hashtable]$Sources,
        [int]$NoveltyMin = 5
    )

    $allItems = [System.Collections.Generic.List[hashtable]]::new()
    $today = Get-Date -Format 'yyyy-MM-dd'

    $categories = @(
        @{ name = 'reddit';  text = $Sources.reddit.text;  ok = $Sources.reddit.ok  },
        @{ name = 'hn';      text = $Sources.hn.text;      ok = $Sources.hn.ok      },
        @{ name = 'github';  text = $Sources.github.text;  ok = $Sources.github.ok  },
        @{ name = 'blogs';   text = $Sources.blogs.text;   ok = $Sources.blogs.ok   }
    )

    $claudeCmd = Get-Command claude -ErrorAction SilentlyContinue

    foreach ($cat in $categories) {
        if (-not $cat.ok -or [string]::IsNullOrWhiteSpace($cat.text)) {
            Write-Host "  [meta-m2] Skipping $($cat.name) - no content" -ForegroundColor DarkGray
            continue
        }

        $extractPrompt = @"
Today is $today. You are reading raw content scraped from a tech news source category: $($cat.name).

Extract all notable items from the content below. For each item emit a JSON object in this exact array.
Emit ONLY the JSON array - no preamble, no explanation, no markdown fencing.

[
  {
    "category": "$($cat.name)",
    "title": "<concise title>",
    "url": "<best URL for the item>",
    "summary": "<2-3 sentence summary of what it is and why it matters>",
    "sourceClaim": "<verbatim excerpt or paraphrase from source>",
    "novelty": <integer 1-10 where 10 = never-seen-before breakthrough>
  }
]

Rules:
- Include items that are genuinely new, surprising, or high-signal.
- novelty score: rate harshly. Known tools no update = 1-3. Known tool with major new version = 6-8. Completely new thing = 9-10.
- If a category has zero notable items, return an empty array: []
- One JSON array only, no commentary.

SOURCE CONTENT:
$($cat.text)
"@

        $extractedJson = $null
        if ($claudeCmd) {
            try {
                $raw = $extractPrompt | & claude --dangerously-skip-permissions --model claude-sonnet-4-6 -p --add-dir $Script:VideoMemRoot 2>&1
                $extractedJson = $raw -join "`n"
            } catch {
                Write-Warning "[meta-m2] claude call failed for $($cat.name): $($_.Exception.Message)"
                continue
            }
        } elseif ($env:ANTHROPIC_API_KEY) {
            $extractedJson = Invoke-NativeMetaExtract -Prompt $extractPrompt
        } else {
            Write-Warning "[meta-m2] claude CLI absent and no ANTHROPIC_API_KEY; cannot extract $($cat.name)"
            continue
        }

        if ([string]::IsNullOrWhiteSpace($extractedJson)) { continue }

        # Parse the JSON array. Strip any accidental markdown fencing first.
        try {
            $cleaned = $extractedJson -replace '(?s)```json\s*', '' -replace '(?s)```\s*', ''
            $parsed = $cleaned | ConvertFrom-Json -ErrorAction Stop
            if ($parsed -isnot [array]) { $parsed = @($parsed) }
            foreach ($item in $parsed) {
                if ($item.novelty -ge $NoveltyMin) {
                    $allItems.Add(@{
                        category    = [string]$item.category
                        title       = [string]$item.title
                        url         = [string]$item.url
                        summary     = [string]$item.summary
                        sourceClaim = [string]$item.sourceClaim
                        novelty     = [int]$item.novelty
                    })
                }
            }
        } catch {
            Write-Warning "[meta-m2] JSON parse failed for $($cat.name): $($_.Exception.Message)"
        }
    }

    Write-Host "  [meta-m2] Extracted $($allItems.Count) items with novelty >= $NoveltyMin" -ForegroundColor DarkGray
    return ,$allItems   # comma prevents PS from unwrapping single-element array
}

# =============================================================================
# META ITEM EXTRACT NATIVE FALLBACK — Anthropic API direct call when claude
# CLI is absent. Returns raw model text or $null on failure.
# =============================================================================
function Invoke-NativeMetaExtract {
    param([string]$Prompt)

    if (-not $env:ANTHROPIC_API_KEY) { return $null }
    $pyCmd = Get-Command python -ErrorAction SilentlyContinue
    if (-not $pyCmd) { return $null }

    $pyScript = @'
import sys, os, json, urllib.request, urllib.error
api_key = os.environ.get('ANTHROPIC_API_KEY', '')
if not api_key:
    sys.exit(1)
prompt_text = sys.stdin.read()
payload = {
    'model': 'claude-sonnet-4-6',
    'max_tokens': 4096,
    'messages': [{'role': 'user', 'content': prompt_text}]
}
data = json.dumps(payload).encode('utf-8')
req = urllib.request.Request(
    'https://api.anthropic.com/v1/messages', data=data,
    headers={'x-api-key': api_key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'},
    method='POST'
)
try:
    with urllib.request.urlopen(req, timeout=90) as resp:
        body = json.loads(resp.read().decode('utf-8'))
        print(body['content'][0]['text'])
except urllib.error.HTTPError as e:
    print(f'[native-extract] HTTP {e.code}', file=sys.stderr); sys.exit(1)
'@

    $pyTempFile = Join-Path $env:TEMP "dossier-meta-extract-$(Get-Random).py"
    try {
        Set-Content -Path $pyTempFile -Value $pyScript -Encoding utf8
        $out = $Prompt | & python $pyTempFile 2>&1
        if ($LASTEXITCODE -eq 0) { return ($out -join "`n") }
        return $null
    } catch {
        return $null
    } finally {
        if (Test-Path $pyTempFile) { Remove-Item $pyTempFile -Force -ErrorAction SilentlyContinue }
    }
}

# =============================================================================
# META DELTA — compares today's extracted items to yesterday's META-DAILY file.
# Returns only items whose URL or title did not appear in yesterday's digest.
# Pure PowerShell - no external calls, no claude needed.
# =============================================================================
function Invoke-MetaDelta {
    param(
        [System.Collections.Generic.List[hashtable]]$TodayItems,
        [string]$VideoMemRoot
    )

    $yesterday = (Get-Date).AddDays(-1).ToString('yyyy-MM-dd')
    $yesterdayPath = Join-Path $VideoMemRoot "META-DAILY-$yesterday.md"

    if (-not (Test-Path $yesterdayPath)) {
        Write-Host "  [meta-m3] No yesterday file ($yesterdayPath) - all $($TodayItems.Count) items are new." -ForegroundColor DarkGray
        return ,$TodayItems
    }

    $yesterdayContent = Get-Content $yesterdayPath -Raw -Encoding utf8
    $newItems = [System.Collections.Generic.List[hashtable]]::new()

    foreach ($item in $TodayItems) {
        # An item is "old" if its URL or its title appears verbatim in yesterday's file
        $titleInYesterday = $item.title -and ($yesterdayContent -match [regex]::Escape($item.title))
        $urlInYesterday   = $item.url   -and ($yesterdayContent -match [regex]::Escape($item.url))
        if (-not $titleInYesterday -and -not $urlInYesterday) {
            $newItems.Add($item)
        }
    }

    Write-Host "  [meta-m3] Delta: $($TodayItems.Count) total, $($newItems.Count) new vs yesterday." -ForegroundColor DarkGray
    return ,$newItems
}

# =============================================================================
# NATIVE RECIPE FALLBACK — calls Anthropic API directly (no claude CLI needed)
# to synthesize RECIPE.md from whatever dossier sources exist.
# Returns $true if RECIPE.md was produced, $false otherwise.
# =============================================================================
function Invoke-NativeRecipe {
    param(
        [string]$OutDir,
        [string]$BriefMd,
        [string]$TranscriptTxt,
        [string]$PortfolioMd,
        [string]$ProfileJson,
        [string]$OwnerUsername,
        [string]$ShortCode,
        [string]$RecipeMd
    )

    if (-not $env:ANTHROPIC_API_KEY) {
        Write-Host "       (ANTHROPIC_API_KEY not set; skipping native recipe fallback)" -ForegroundColor DarkGray
        return $false
    }

    $pyCmd = Get-Command python -ErrorAction SilentlyContinue
    if (-not $pyCmd) {
        Write-Host "       (python not on PATH; skipping native recipe fallback)" -ForegroundColor DarkGray
        return $false
    }

    Write-Host "       Synthesizing RECIPE.md via native Anthropic API fallback ..." -ForegroundColor DarkGray

    # Build content string from available sources
    $contentParts = [System.Collections.Generic.List[string]]::new()
    if ($BriefMd -and (Test-Path $BriefMd)) {
        $contentParts.Add("## BRIEF.md`n" + (Get-Content $BriefMd -Raw -Encoding utf8))
    }
    if ($TranscriptTxt -and (Test-Path $TranscriptTxt)) {
        $raw = Get-Content $TranscriptTxt -Raw -Encoding utf8
        # Truncate transcript to 8000 chars to stay within token budget
        if ($raw.Length -gt 8000) { $raw = $raw.Substring(0, 8000) + "`n[... truncated ...]" }
        $contentParts.Add("## transcript.txt`n" + $raw)
    }
    if ($PortfolioMd -and (Test-Path $PortfolioMd)) {
        $contentParts.Add("## PORTFOLIO-TOUR.md`n" + (Get-Content $PortfolioMd -Raw -Encoding utf8))
    }
    if ($contentParts.Count -eq 0) {
        Write-Warning "No source files available for native recipe; skipping."
        return $false
    }

    $sourcesText = $contentParts -join "`n`n---`n`n"

    # The Python script reads ANTHROPIC_API_KEY and DOSSIER_RECIPE_PATH from env,
    # and receives the prompt text via stdin to avoid shell quoting issues.
    $pyScript = @'
import sys, os, json, urllib.request, urllib.error

api_key = os.environ.get('ANTHROPIC_API_KEY', '')
out_path = os.environ.get('DOSSIER_RECIPE_PATH', '')
if not api_key:
    print('[native-recipe] ANTHROPIC_API_KEY not set', file=sys.stderr)
    sys.exit(1)
if not out_path:
    print('[native-recipe] DOSSIER_RECIPE_PATH not set', file=sys.stderr)
    sys.exit(1)

prompt_text = sys.stdin.read()

payload = {
    'model': 'claude-sonnet-4-6',
    'max_tokens': 2048,
    'messages': [{'role': 'user', 'content': prompt_text}]
}
data = json.dumps(payload).encode('utf-8')
req = urllib.request.Request(
    'https://api.anthropic.com/v1/messages',
    data=data,
    headers={
        'x-api-key': api_key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
    },
    method='POST'
)
try:
    with urllib.request.urlopen(req, timeout=90) as resp:
        body = json.loads(resp.read().decode('utf-8'))
    recipe_text = body['content'][0]['text']
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(recipe_text)
    print('[native-recipe] RECIPE.md written OK')
except urllib.error.HTTPError as e:
    err_body = e.read().decode('utf-8', errors='replace')
    print(f'[native-recipe] HTTP {e.code}: {err_body}', file=sys.stderr)
    sys.exit(1)
except Exception as e:
    print(f'[native-recipe] error: {e}', file=sys.stderr)
    sys.exit(1)
'@

    $recipePrompt = @"
You are synthesizing a reproduction recipe for a creator's portfolio work.

Dossier owner: @$OwnerUsername
Short code:    $ShortCode

Source material (use everything provided):
$sourcesText

Synthesize RECIPE.md with this structure:
# Recipe - @$OwnerUsername / $ShortCode

## Stack to use
(Bullet list. Specific library names + versions where known.
 Include framework, 3D/animation libs, scroll lib, font choices.)

## Step-by-step build
(Numbered steps. Each step should be actionable: what to install, what
 file to create, what code primitive to write. No hand-waving.)

## Key techniques
(Bullet list of the 3-7 visual techniques that produce the look.
 Be specific about CSS properties, easing curves, parallax depths,
 lighting setups, etc. Avoid generic advice.)

## Honest assessment
(2-3 sentences: how hard is this to reproduce? Is the magic in 1
 technique or 5? Is it realtime or pre-rendered?)

Be specific. Cite library names. Do NOT include preamble - start with the heading.
"@

    $pyTempFile = [System.IO.Path]::GetTempFileName() + '.py'
    try {
        Set-Content -Path $pyTempFile -Value $pyScript -Encoding utf8
        $env:DOSSIER_RECIPE_PATH = $RecipeMd
        $recipePrompt | & python $pyTempFile 2>&1 | Out-Host
        if ($LASTEXITCODE -eq 0 -and (Test-Path $RecipeMd)) {
            Write-Host "       RECIPE.md written via native API fallback" -ForegroundColor DarkGray
            return $true
        } else {
            Write-Warning "Native recipe fallback: python exited $LASTEXITCODE or RECIPE.md not produced."
            return $false
        }
    } catch {
        Write-Warning "Native recipe fallback threw: $($_.Exception.Message)"
        return $false
    } finally {
        $env:DOSSIER_RECIPE_PATH = $null
        if (Test-Path $pyTempFile) { Remove-Item $pyTempFile -Force -ErrorAction SilentlyContinue }
    }
}

# =============================================================================
# NATIVE TOUR FALLBACK — runs a minimal Python/Playwright script to capture
# portfolio screenshots and write PORTFOLIO-TOUR.md, no claude CLI needed.
# Returns $true if PORTFOLIO-TOUR.md was produced, $false otherwise.
# =============================================================================
function Invoke-NativeTour {
    param(
        [string]$OutDir,
        [string]$TargetUrl,
        [string]$PortfolioMd,
        [string]$OwnerUsername
    )

    $pyCmd = Get-Command python -ErrorAction SilentlyContinue
    if (-not $pyCmd) {
        Write-Host "       (python not on PATH; skipping native tour fallback)" -ForegroundColor DarkGray
        return $false
    }

    # Check playwright is importable
    $null = & python -c "import playwright" 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "       (playwright not installed; skipping native tour fallback)" -ForegroundColor DarkGray
        return $false
    }

    Write-Host "       Running native Python/Playwright tour fallback ..." -ForegroundColor DarkGray

    # Single-quoted here-string: no PS variable expansion inside.
    # URL and output dir are passed via env vars DOSSIER_TARGET_URL and DOSSIER_OUT_DIR.
    $pyScript = @'
import sys, os, json
from datetime import date

target_url = os.environ.get('DOSSIER_TARGET_URL', '')
out_dir = os.environ.get('DOSSIER_OUT_DIR', '')
owner = os.environ.get('DOSSIER_OWNER', '')

if not target_url:
    print('[native-tour] DOSSIER_TARGET_URL not set', file=sys.stderr)
    sys.exit(1)
if not out_dir:
    print('[native-tour] DOSSIER_OUT_DIR not set', file=sys.stderr)
    sys.exit(1)

viewport_png = os.path.join(out_dir, 'portfolio-viewport.png')
fullpage_png = os.path.join(out_dir, 'portfolio-fullpage.png')
tour_md = os.path.join(out_dir, 'PORTFOLIO-TOUR.md')

fingerprint_js = """
(function() {
  var d = document;
  return {
    detected: {
      React: !!(window.React || d.querySelector('[data-reactroot],[data-reactid]')),
      Next: !!(window.__NEXT_DATA__ || d.getElementById('__next')),
      Vue: !!(window.Vue || window.__vue_app__),
      Webflow: !!(window.Webflow),
      GSAP: !!(window.gsap || window.TweenMax),
      Lenis: !!(window.Lenis),
      THREE: !!(window.THREE),
      Astro: !!(d.querySelector('meta[name=\"generator\"][content*=\"Astro\"]'))
    },
    canvasCount: d.querySelectorAll('canvas').length,
    videoCount: d.querySelectorAll('video').length,
    imgCount: d.querySelectorAll('img').length,
    linkCount: d.querySelectorAll('a').length,
    docTitle: d.title,
    docLen: d.documentElement.outerHTML.length,
    generator: (d.querySelector('meta[name=\"generator\"]') || {}).content || null,
    bodyClasses: d.body.className,
    allScriptCount: d.querySelectorAll('script').length
  };
})()
"""

try:
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        page.goto(target_url, wait_until='networkidle', timeout=30000)
        page.screenshot(path=viewport_png)
        page.screenshot(path=fullpage_png, full_page=True)
        fp = page.evaluate(fingerprint_js)
        browser.close()

    fp_json = json.dumps(fp, indent=2)
    today = date.today().isoformat()

    lines = [
        '# Portfolio Tour -- ' + owner + ' -- ' + target_url,
        '',
        '- **URL**: ' + target_url,
        '- **Date**: ' + today,
        '- **Dossier folder**: `' + out_dir + '`',
        '- **Page title**: ' + fp.get('docTitle', '(unknown)'),
        '',
        '## Fingerprint',
        '',
        '```json',
        fp_json,
        '```',
        '',
        '## Screenshots',
        '',
        '![Viewport](./portfolio-viewport.png)',
        '![Full page](./portfolio-fullpage.png)',
        '',
        '## Notes',
        '',
        '*(Generated by native Python/Playwright fallback. No claude CLI was available.)*',
        '',
    ]

    with open(tour_md, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))

    print('[native-tour] PORTFOLIO-TOUR.md written OK')

except Exception as e:
    print(f'[native-tour] error: {e}', file=sys.stderr)
    sys.exit(1)
'@

    $pyTempFile = [System.IO.Path]::GetTempFileName() + '.py'
    try {
        Set-Content -Path $pyTempFile -Value $pyScript -Encoding utf8
        $env:DOSSIER_TARGET_URL = $TargetUrl
        $env:DOSSIER_OUT_DIR    = $OutDir
        $env:DOSSIER_OWNER      = $OwnerUsername
        & python $pyTempFile 2>&1 | Out-Host
        if ($LASTEXITCODE -eq 0 -and (Test-Path $PortfolioMd)) {
            Write-Host "       PORTFOLIO-TOUR.md written via native fallback" -ForegroundColor DarkGray
            return $true
        } else {
            Write-Warning "Native tour fallback: python exited $LASTEXITCODE or PORTFOLIO-TOUR.md not produced."
            return $false
        }
    } catch {
        Write-Warning "Native tour fallback threw: $($_.Exception.Message)"
        return $false
    } finally {
        $env:DOSSIER_TARGET_URL = $null
        $env:DOSSIER_OUT_DIR    = $null
        $env:DOSSIER_OWNER      = $null
        if (Test-Path $pyTempFile) { Remove-Item $pyTempFile -Force -ErrorAction SilentlyContinue }
    }
}

# =============================================================================
# CORE PIPELINE — given a normalized post dict, run frames + audio + Whisper +
# profile chase + manifest + brief + html + (optional) Playwright tour + recipe.
# Returns a hashtable describing the result.
# =============================================================================
function Invoke-DossierPipeline {
    param(
        [hashtable]$Post,            # normalized post dict (output of platform scrapers)
        [string]$OriginalUrl,
        [hashtable]$Whisper,         # output of Get-WhisperBackend
        [bool]$DoTour,
        [bool]$DoRecipe,
        [bool]$DoOpen,

        # v3.1 Feature A
        [bool]$DoNotebookLM = $true,
        [string]$NotebookName,
        [bool]$AutoPodcast = $false,

        # v3.1 Feature B — THE ARCHIVE
        [bool]$NoArchive = $false,
        [bool]$RebuildArchive = $false
    )

    $platform      = $Post.platform
    $ownerUsername = $Post.ownerUsername
    $shortCode     = $Post.shortCode

    # Build output folder
    $dateStr   = Get-Date -Format 'yyyy-MM-dd'
    $safeUser  = ($ownerUsername -replace '[^a-zA-Z0-9._-]', '_')
    $folderName= "${dateStr}_${safeUser}_${shortCode}"
    $outDir    = Join-Path $Script:VideoMemRoot $folderName
    $framesDir = Join-Path $outDir 'frames'
    try {
        New-Item -ItemType Directory -Force -Path $outDir   | Out-Null
        New-Item -ItemType Directory -Force -Path $framesDir | Out-Null
    } catch {
        throw "Could not create output folder $outDir : $($_.Exception.Message)"
    }

    $videoPath     = Join-Path $outDir 'source.mp4'
    $audioPath     = Join-Path $outDir 'audio.aac'
    $audioWavPath  = Join-Path $outDir 'audio.wav'
    $transcriptTxt = Join-Path $outDir 'transcript.txt'
    $transcriptSrt = Join-Path $outDir 'transcript.srt'
    $profileJson   = Join-Path $outDir 'profile.json'
    $briefMd       = Join-Path $outDir 'BRIEF.md'
    $htmlPath      = Join-Path $outDir 'index.html'
    $portfolioMd   = Join-Path $outDir 'PORTFOLIO-TOUR.md'
    $recipeMd      = Join-Path $outDir 'RECIPE.md'
    $framesPattern = Join-Path $framesDir 'f%03d.png'

    # Decide step count based on what's active for this run (cosmetic — for the [N/M] indicator)
    # Step counter - using a single hashtable so we can pass-by-reference into the
    # local Step helper without falling into PowerShell's nested-function-scope trap
    # (where $script:foo would point to the outermost module scope, not us).
    # 6 base steps: download, frames, audio, manifest, brief, html.
    # (v3 had 5 because brief+html were one step; v3.1 splits the HTML render to
    #  the very end of the pipeline so it captures the optional NotebookLM section.)
    $stepCtx = @{ Idx = 0; Total = 6 }
    if ($Whisper.Backend) { $stepCtx.Total += 1 }
    if ($platform -eq 'instagram') { $stepCtx.Total += 1 }   # profile chase
    if ($DoTour)   { $stepCtx.Total += 1 }
    if ($DoRecipe) { $stepCtx.Total += 1 }
    if ($DoNotebookLM) { $stepCtx.Total += 1 }
    if (-not $NoArchive) { $stepCtx.Total += 1 }
    $Step = {
        param([string]$label)
        $stepCtx.Idx += 1
        Write-Host "[$($stepCtx.Idx)/$($stepCtx.Total)] $label" -ForegroundColor Cyan
    }.GetNewClosure()

    # --- Download video (skip if yt-dlp already saved it) ---
    if ($Post.localFile -and (Test-Path $Post.localFile)) {
        & $Step "Video already downloaded by yt-dlp -> $videoPath"
        if ($Post.localFile -ne $videoPath) { Move-Item -Force $Post.localFile $videoPath }
    } else {
        & $Step "Downloading video to $videoPath ..."
        try {
            Invoke-WebRequest -Uri $Post.videoUrl -OutFile $videoPath -TimeoutSec 300
        } catch {
            throw "Video download failed: $($_.Exception.Message)"
        }
    }
    if (-not (Test-Path $videoPath) -or (Get-Item $videoPath).Length -lt 1024) {
        throw "Downloaded video is missing or suspiciously small (<1KB)."
    }

    # --- Frames ---
    & $Step "Extracting frames (1fps, scale=540) ..."
    & ffmpeg -y -hide_banner -loglevel error -i $videoPath -vf 'fps=1,scale=540:-1' $framesPattern
    if ($LASTEXITCODE -ne 0) { throw "ffmpeg frame extraction failed (exit $LASTEXITCODE)." }
    $frameCount = (Get-ChildItem -Path $framesDir -Filter 'f*.png' -File).Count
    if ($frameCount -lt 1) { throw "ffmpeg produced no frames." }

    # --- Audio ---
    & $Step "Extracting audio ..."
    & ffmpeg -y -hide_banner -loglevel error -i $videoPath -vn -acodec copy $audioPath
    $audioOk = $true
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "ffmpeg audio extraction failed. Continuing without audio."
        $audioOk = $false
    }
    elseif (-not (Test-Path $audioPath) -or (Get-Item $audioPath).Length -lt 100) {
        Write-Warning "Audio empty/missing — likely silent. Skipping."
        $audioOk = $false
    }

    # --- Whisper (optional) ---
    $transcriptOk = $false
    $transcriptionReason = 'Whisper not installed'
    if ($audioOk -and $Whisper.Backend) {
        & $Step "Transcribing audio with $($Whisper.Backend) ..."
        & ffmpeg -y -hide_banner -loglevel error -i $audioPath -ac 1 -ar 16000 $audioWavPath
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "WAV transcode failed. Skipping transcription."
            $transcriptionReason = 'WAV transcode failed'
        } else {
            try {
                switch ($Whisper.Backend) {
                    'faster-whisper' {
                        $pyScript = @"
import sys, os, sysconfig

# Pip-installed nvidia-* DLLs live under site-packages/nvidia/<lib>/bin but
# Python does not auto-register those for the Windows DLL search. To make
# ctranslate2 actually find them at inference time:
#   1. Use sysconfig (nvidia is a namespace package; nvidia.__file__ is None)
#   2. RETAIN the os.add_dll_directory cookies in a list. If discarded, the
#      directory is silently removed from search and you crash mid-transcribe.
#   3. Also prepend to PATH as belt-and-suspenders for any C-extension that
#      bypasses Python's DLL search modifications.
_dll_cookies = []  # MUST stay alive for the entire script run
try:
    _purelib = sysconfig.get_paths()['purelib']
    _nvidia_bins = []
    for _sub in ('cublas', 'cudnn', 'cuda_nvrtc', 'cuda_runtime'):
        _bin = os.path.join(_purelib, 'nvidia', _sub, 'bin')
        if os.path.isdir(_bin):
            _dll_cookies.append(os.add_dll_directory(_bin))
            _nvidia_bins.append(_bin)
    if _nvidia_bins:
        os.environ['PATH'] = os.pathsep.join(_nvidia_bins) + os.pathsep + os.environ.get('PATH', '')
except Exception as _e:
    print(f'[whisper] DLL path setup warning: {_e}', file=sys.stderr)

from faster_whisper import WhisperModel
wav = r'''$audioWavPath'''
out_txt = r'''$transcriptTxt'''
out_srt = r'''$transcriptSrt'''

# Try GPU first (RTX-class hardware, ~10x real-time), fall back to CPU otherwise.
# We only fall back on init errors here; mid-transcribe DLL-load errors still
# surface as a non-zero exit and the calling script marks transcription as
# failed (soft-skip, pipeline continues).
try:
    model = WhisperModel('small', device='cuda', compute_type='float16')
    _device = 'cuda'
except Exception as _e:
    print(f"[whisper] GPU init failed: {_e}; using CPU", file=sys.stderr)
    model = WhisperModel('small', device='cpu', compute_type='int8')
    _device = 'cpu'
print(f"[whisper] device={_device}", file=sys.stderr)

segments, info = model.transcribe(wav, beam_size=1, vad_filter=True)
segments = list(segments)
def fmt(t):
    h = int(t // 3600); m = int((t % 3600) // 60); s = t % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}".replace('.', ',')
with open(out_txt, 'w', encoding='utf-8') as f:
    for seg in segments: f.write(seg.text.strip() + '\n')
with open(out_srt, 'w', encoding='utf-8') as f:
    for i, seg in enumerate(segments, 1):
        f.write(f"{i}\n{fmt(seg.start)} --> {fmt(seg.end)}\n{seg.text.strip()}\n\n")
print(f"OK lang={info.language} segments={len(segments)}")
"@
                        $pyScript | & python -
                        if ($LASTEXITCODE -eq 0 -and (Test-Path $transcriptTxt)) { $transcriptOk = $true }
                        else { $transcriptionReason = "faster-whisper exit $LASTEXITCODE" }
                    }
                    'openai-whisper' {
                        & python -m whisper $audioWavPath --model small --output_dir $outDir --output_format all --language en --fp16 False 2>&1 | Out-Host
                        if ($LASTEXITCODE -eq 0) {
                            $base = [System.IO.Path]::GetFileNameWithoutExtension($audioWavPath)
                            if (Test-Path (Join-Path $outDir "$base.txt")) { Move-Item -Force (Join-Path $outDir "$base.txt") $transcriptTxt }
                            if (Test-Path (Join-Path $outDir "$base.srt")) { Move-Item -Force (Join-Path $outDir "$base.srt") $transcriptSrt }
                            if (Test-Path $transcriptTxt) { $transcriptOk = $true }
                            else { $transcriptionReason = 'openai-whisper produced no transcript' }
                        } else { $transcriptionReason = "openai-whisper exit $LASTEXITCODE" }
                    }
                    'whisper.cpp' {
                        $modelPath = $env:WHISPER_MODEL
                        if (-not $modelPath -or -not (Test-Path $modelPath)) {
                            Write-Warning "whisper.cpp present but `$env:WHISPER_MODEL not set."
                            $transcriptionReason = 'whisper.cpp model not configured'
                        } else {
                            & $Whisper.Bin -m $modelPath -f $audioWavPath -otxt -osrt -of (Join-Path $outDir 'transcript') 2>&1 | Out-Host
                            if ((Test-Path $transcriptTxt) -and $LASTEXITCODE -eq 0) { $transcriptOk = $true }
                            else { $transcriptionReason = "whisper.cpp exit $LASTEXITCODE" }
                        }
                    }
                }
            } catch {
                Write-Warning "Transcription error: $($_.Exception.Message)"
                $transcriptionReason = "exception: $($_.Exception.Message)"
            }
        }
        if ($transcriptOk) {
            Write-Host "       transcript.txt + transcript.srt written" -ForegroundColor DarkGray
        } else {
            Write-Warning "Transcription failed ($transcriptionReason)."
        }
    }
    elseif (-not $audioOk) {
        $transcriptionReason = 'no audio extracted'
    }

    # --- Profile chase (Instagram only — TikTok/YT don't have a directly comparable bio-link concept) ---
    $profileOk = $false
    $profile = $null
    $profileError = $null
    if ($platform -eq 'instagram') {
        & $Step "Calling Apify (instagram-profile-scraper) for @$ownerUsername ..."
        try {
            $profileItems = Invoke-ApifyActor -ActorId 'apify~instagram-profile-scraper' -InputBody @{
                usernames = @($ownerUsername)
            }
            if ($profileItems -and $profileItems.Count -gt 0) {
                $p = $profileItems[0]
                $rawLatest = @()
                if ($p.latestPosts) { $rawLatest = $p.latestPosts }
                elseif ($p.posts)   { $rawLatest = $p.posts }
                $top3 = @()
                for ($i = 0; $i -lt [Math]::Min(3, $rawLatest.Count); $i++) {
                    $lp = $rawLatest[$i]
                    $cap = if ($lp.caption) { [string]$lp.caption } else { '' }
                    if ($cap.Length -gt 200) { $cap = $cap.Substring(0, 200) + '...' }
                    $top3 += [ordered]@{ caption = $cap; url = $lp.url; shortCode = $lp.shortCode }
                }
                $profile = [ordered]@{
                    username      = $p.username
                    fullName      = $p.fullName
                    bio           = $p.biography
                    externalUrl   = $p.externalUrl
                    followersCount= $p.followersCount
                    postsCount    = $p.postsCount
                    latestPosts   = $top3
                }
                $profile | ConvertTo-Json -Depth 6 | Set-Content -Path $profileJson -Encoding utf8
                $profileOk = $true
                Write-Host "       profile.json written" -ForegroundColor DarkGray
            } else {
                $profileError = 'profile-scraper returned no items'
                Write-Warning "Profile scrape returned no items for @$ownerUsername."
            }
        } catch {
            $profileError = $_.Exception.Message
            Write-Warning "Profile scrape failed: $profileError."
        }
    }

    # --- Manifest ---
    & $Step "Writing manifest.json ..."
    $manifest = [ordered]@{
        post_url        = $OriginalUrl
        platform        = $platform
        owner_username  = $ownerUsername
        caption         = if ($Post.caption.Length -gt 500) { $Post.caption.Substring(0, 500) } else { $Post.caption }
        timestamp       = $Post.timestamp
        shortCode       = $shortCode
        likes_count     = $Post.likesCount
        video_views     = $Post.videoViewCount
        comments_count  = $Post.commentsCount
        frame_count     = $frameCount
        audio_path      = if ($audioOk) { $audioPath } else { $null }
        video_path      = $videoPath
        display_url     = $Post.displayUrl
        transcript_path = if ($transcriptOk) { $transcriptTxt } else { $null }
        transcript_srt  = if ($transcriptOk -and (Test-Path $transcriptSrt)) { $transcriptSrt } else { $null }
        profile_path    = if ($profileOk) { $profileJson } else { $null }
        whisper_backend = $Whisper.Backend
        fetched_at      = (Get-Date).ToString('o')
        dossier_version = 3
    }
    $manifestPath = Join-Path $outDir 'manifest.json'
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -Path $manifestPath -Encoding utf8

    # --- BRIEF.md (HTML render deferred until after auto-tour / auto-recipe / NotebookLM) ---
    & $Step "Generating BRIEF.md ..."

    $transcriptPreview = if ($transcriptOk -and (Test-Path $transcriptTxt)) {
        $raw = Get-Content -Path $transcriptTxt -Raw -Encoding utf8
        if ($raw.Length -gt 1000) { $raw.Substring(0, 1000) + '...' } else { $raw }
    } else {
        "No transcript - $transcriptionReason."
    }

    $pName   = if ($profileOk -and $profile.fullName)    { $profile.fullName }    else { '_unknown_' }
    $pBio    = if ($profileOk -and $profile.bio)         { $profile.bio }         else { '_no bio_' }
    $pUrl    = if ($profileOk -and $profile.externalUrl) { $profile.externalUrl } else { $null }
    $pFollow = if ($profileOk -and $null -ne $profile.followersCount) { $profile.followersCount } else { '_unknown_' }
    $pPosts  = if ($profileOk -and $null -ne $profile.postsCount)     { $profile.postsCount }     else { '_unknown_' }

    $captionPreview = if ($Post.caption.Length -gt 500) { $Post.caption.Substring(0, 500) + '...' } else { $Post.caption }
    if (-not $captionPreview) { $captionPreview = '_no caption_' }

    $likesStr = if ($null -ne $Post.likesCount)     { $Post.likesCount }     else { '?' }
    $viewsStr = if ($null -ne $Post.videoViewCount) { $Post.videoViewCount } else { '?' }
    $commsStr = if ($null -ne $Post.commentsCount)  { $Post.commentsCount }  else { '?' }

    $nextStep = if ($pUrl) {
        "Auto-Playwright tour will run on $pUrl (or has already run). See PORTFOLIO-TOUR.md."
    } elseif ($platform -ne 'instagram') {
        "$platform doesn't have a bio external-URL convention — no portfolio tour."
    } else {
        "No portfolio URL in creator's bio - skip the Playwright tour."
    }
    $urlLine = if ($pUrl) { $pUrl } else { 'none' }

    $brief = @"
# Dossier - @$ownerUsername - $shortCode  ($platform)

**Post:** $OriginalUrl
**Posted:** $($Post.timestamp)
**Engagement:** $likesStr likes / $viewsStr views / $commsStr comments

## Caption

$captionPreview

## Transcript (first 1000 chars)

$transcriptPreview

## Creator Profile

- **Name:** $pName
- **Bio:** $pBio
- **Portfolio URL:** $urlLine
- **Followers:** $pFollow
- **Posts:** $pPosts

## Frames

$frameCount frames extracted at 1fps. Path: $framesDir

## Recommended Next Step

$nextStep
"@
    $brief | Set-Content -Path $briefMd -Encoding utf8

    # NOTE: index.html is rendered later (after auto-tour, auto-recipe, and the
    # NotebookLM auto-pipe) so the BRIEF.md it embeds includes the optional
    # "## NotebookLM" section appended by Invoke-NotebookLMPipe.

    # --- Auto-Playwright tour (upgrade A) ---
    $tourRan = $false
    if ($DoTour -and $pUrl) {
        $claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
        if ($claudeCmd) {
            & $Step "Running auto-Playwright tour via claude CLI ..."
            $tourPrompt = @"
Before generating any code, read C:\Users\renea\video-memory\INDEX.md and follow the
"Playwright recon pattern" section.

Target URL: $pUrl
Source dossier folder (write all artifacts here): $outDir

Steps:
1. Navigate to the URL using the Playwright MCP:
   mcp__plugin_playwright_playwright__browser_navigate({ url: "$pUrl" })
2. Take screenshots and save into the dossier folder:
   - viewport screenshot  -> $outDir\portfolio-viewport.png
   - full-page screenshot -> $outDir\portfolio-fullpage.png
3. Run the JavaScript fingerprint evaluate from INDEX.md (returns
   { detected, libHints, canvasCount, videoCount, headings }).
4. Write a markdown report to $outDir\PORTFOLIO-TOUR.md containing:
   - URL, date, dossier folder this belongs to
   - The fingerprint JSON (pretty-printed)
   - 3-5 bullet "what's the stack" interpretation in plain English
   - 2-3 bullet "what would it take to imitate this" estimate
   - Embedded references to the two screenshots above
5. Confirm both screenshots and PORTFOLIO-TOUR.md exist before ending.
"@
            try {
                # Try `claude -p` first (one-shot prompt mode), then fall back to dangerous-skip-permissions.
                # --add-dir grants claude read/write to the dossier folder; without it the
                # child claude session is sandboxed to the script's CWD and refuses cross-tree reads.
                Remove-Item -Path $portfolioMd -ErrorAction SilentlyContinue
                $tourLog = Join-Path $outDir 'claude-tour.log'
                Set-Content -Path $tourLog -Value '=== claude -p --dangerously-skip-permissions --model claude-sonnet-4-6 ===' -Encoding utf8
                $tourPrompt | & claude --dangerously-skip-permissions --model claude-sonnet-4-6 -p --add-dir $Script:VideoMemRoot 2>&1 | Tee-Object -FilePath $tourLog -Append | Out-Host
                if (Test-Path $portfolioMd) {
                    $tourRan = $true
                    Write-Host "       PORTFOLIO-TOUR.md written" -ForegroundColor DarkGray
                } else {
                    Write-Warning "claude CLI ran but PORTFOLIO-TOUR.md not produced. Check output above."
                }
            } catch {
                Write-Warning "claude CLI failed: $($_.Exception.Message). Falling back to claude-prompt.txt."
            }

            if ($FirecrawlPortfolio -and $pUrl) {
                if (-not (Test-FirecrawlTokenLooksValid $env:FIRECRAWL_API_KEY)) {
                    Read-FirecrawlTokenInteractive
                }
                try {
                    $fcBody = @{ url = $pUrl; formats = @('markdown') } | ConvertTo-Json
                    $fcHeaders = @{ 'Authorization' = "Bearer $env:FIRECRAWL_API_KEY"; 'Content-Type' = 'application/json' }
                    $fcResp = Invoke-RestMethod -Uri 'https://api.firecrawl.dev/v1/scrape' -Method Post -Headers $fcHeaders -Body $fcBody -TimeoutSec 60
                    if ($fcResp.data.markdown) {
                        $portfolioContentPath = Join-Path $outDir 'PORTFOLIO-CONTENT.md'
                        Set-Content -Path $portfolioContentPath -Value $fcResp.data.markdown -Encoding UTF8
                        Add-Content -Path (Join-Path $outDir 'BRIEF.md') -Value "`n## Portfolio Content (Firecrawl)`n`nSee [PORTFOLIO-CONTENT.md](./PORTFOLIO-CONTENT.md)`n"
                        Write-Host "  [firecrawl] portfolio content saved" -ForegroundColor Green
                    }
                } catch {
                    Write-Host "  [firecrawl] failed: $_" -ForegroundColor Yellow
                }
            }
        } else {
            # claude CLI not on PATH — try native Python/Playwright fallback, then
            # write claude-prompt.txt for manual paste as a last resort.
            $tourRan = Invoke-NativeTour -OutDir $outDir -TargetUrl $pUrl -PortfolioMd $portfolioMd -OwnerUsername $ownerUsername
            if (-not $tourRan) {
                Write-Warning "Native tour fallback also unavailable - writing claude-prompt.txt for manual paste."
                $promptTxt = Join-Path $outDir 'claude-prompt.txt'
                @"
# Playwright recon - @$ownerUsername's portfolio

Before generating any code, read C:\Users\renea\video-memory\INDEX.md and follow the
"Playwright recon pattern" section.

## Target URL
$pUrl

## Source dossier folder (write all artifacts here)
$outDir

## Steps
1. Navigate via Playwright MCP
2. Save viewport + full-page screenshots into $outDir
3. Run the JS fingerprint evaluate from INDEX.md
4. Write $outDir\PORTFOLIO-TOUR.md
"@ | Set-Content -Path $promptTxt -Encoding utf8
            }
        }
    } elseif ($DoTour -and -not $pUrl) {
        Write-Host "       (No portfolio URL; skipping Playwright tour)" -ForegroundColor DarkGray
    }

    # --- Auto-recipe (upgrade G) ---
    $recipeRan = $false
    if ($DoRecipe) {
        $claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
        if ($claudeCmd) {
            & $Step "Synthesizing RECIPE.md via claude CLI ..."
            $recipePrompt = @"
You're synthesizing a reproduction recipe. The dossier folder is:
$outDir

Read these files (only those that exist):
- $briefMd
- $transcriptTxt (if it exists)
- $portfolioMd (if it exists)
- $profileJson (if it exists)
And glance at the frames in $framesDir (especially f001, f$('{0:D3}' -f [Math]::Max(1,[int]($frameCount/2))), f$('{0:D3}' -f $frameCount)).

Synthesize $recipeMd with this structure:
# Recipe - @$ownerUsername / $shortCode

## Stack to use
(Bullet list. Specific library names + versions where known.
 Include framework, 3D/animation libs, scroll lib, font choices.)

## Step-by-step build
(Numbered steps. Each step should be actionable: what to install, what
 file to create, what code primitive to write. No hand-waving.)

## Key techniques
(Bullet list of the 3-7 visual techniques that produce the look.
 Be specific about CSS properties, easing curves, parallax depths,
 lighting setups, etc. Avoid generic advice. If any technique here
 closely rhymes with one from another RECIPE.md visible via your
 --add-dir archive, mention the connection at the end of that bullet
 as "(connects to @username/shortCode - <one phrase>)". Don't force
 a connection if none feels right.)

## Honest assessment
(2-3 sentences: how hard is this to reproduce? Is the magic in 1
 technique or 5? Is it realtime or pre-rendered?)

## Builds On
List 1-3 existing dossiers from your --add-dir archive whose techniques
this post directly extends, remixes, or improves upon. Format each ref as:
- @username/shortCode - [one-sentence explanation of the move borrowed or evolved]
If this post is genuinely original with no clear ancestors in the archive,
write: - (none). Do not invent connections.

Be specific. Cite library names. Reference the frames you looked at.
Do NOT include preamble - start with the heading.
"@
            try {
                Remove-Item -Path $recipeMd -ErrorAction SilentlyContinue
                $recipeLog = Join-Path $outDir 'claude-recipe.log'
                Set-Content -Path $recipeLog -Value '=== claude -p --dangerously-skip-permissions --model claude-haiku-4-5-20251001 ===' -Encoding utf8
                $recipePrompt | & claude --dangerously-skip-permissions --model claude-sonnet-4-6 -p --add-dir $Script:VideoMemRoot 2>&1 | Tee-Object -FilePath $recipeLog -Append | Out-Host
                if (Test-Path $recipeMd) {
                    $recipeRan = $true
                    Write-Host "       RECIPE.md written" -ForegroundColor DarkGray

                    # Parse ## Builds On section and persist refs to manifest.json.
                    # Reuses the same ordered-hashtable rebuild pattern used for
                    # notebooklm_url at lines ~2940-2949.
                    try {
                        $recipeText = Get-Content $recipeMd -Raw -Encoding utf8
                        $buildsOnRefs = @()
                        if ($recipeText -match '(?ms)^## Builds On\s*\r?\n(.*?)(?=^##|\z)') {
                            $sectionText = $Matches[1]
                            $refMatches = [regex]::Matches($sectionText, '@([\w.-]+)/([\w-]+)')
                            foreach ($rm in $refMatches) {
                                $buildsOnRefs += "$($rm.Groups[1].Value)/$($rm.Groups[2].Value)"
                            }
                            $buildsOnRefs = @($buildsOnRefs | Select-Object -Unique)
                        }
                        # Always write builds_on (even empty array) so a re-run
                        # that drops the ## Builds On section clears the stale
                        # lineage instead of preserving it forever.
                        # Codex Wave 4 review caught the prior write-only-when-nonzero
                        # pattern leaving stale entries in manifest.json.
                        $mfPath = Join-Path $outDir 'manifest.json'
                        if (Test-Path $mfPath) {
                            $mfObj = Get-Content $mfPath -Raw -Encoding utf8 | ConvertFrom-Json
                            $mfBuild = [ordered]@{}
                            foreach ($prop in $mfObj.PSObject.Properties) { $mfBuild[$prop.Name] = $prop.Value }
                            $mfBuild['builds_on'] = $buildsOnRefs
                            $mfBuild | ConvertTo-Json -Depth 6 | Set-Content -Path $mfPath -Encoding utf8
                            if ($buildsOnRefs.Count -gt 0) {
                                Write-Host "       builds_on: $($buildsOnRefs -join ', ')" -ForegroundColor DarkGray
                            } else {
                                Write-Host "       builds_on: (none - cleared any stale lineage)" -ForegroundColor DarkGray
                            }
                        }
                    } catch {
                        Write-Host "       [lineage] failed to parse Builds On: $($_.Exception.Message)" -ForegroundColor DarkGray
                    }
                } else {
                    Write-Warning "claude CLI ran but RECIPE.md not produced."
                }
            } catch {
                Write-Warning "claude CLI failed for recipe: $($_.Exception.Message)."
            }
        } else {
            # claude CLI not on PATH — try native Anthropic API fallback
            $recipeRan = Invoke-NativeRecipe `
                -OutDir       $outDir `
                -BriefMd      $briefMd `
                -TranscriptTxt $transcriptTxt `
                -PortfolioMd  $portfolioMd `
                -ProfileJson  $profileJson `
                -OwnerUsername $ownerUsername `
                -ShortCode    $shortCode `
                -RecipeMd     $recipeMd
        }
    }

    # --- NotebookLM auto-pipe (v3.1 Feature A) ---
    # Runs after recipe so all 3 source documents (transcript / brief / recipe)
    # are settled. Soft-fails on every error path. Appends "## NotebookLM" to
    # BRIEF.md and writes notebooklm_url into manifest.json before HTML renders.
    $notebookOk        = $false
    $notebookUrl       = $null
    $notebookPodcastId = $null
    if ($DoNotebookLM) {
        & $Step "Piping dossier into NotebookLM ..."
        $nb = Invoke-NotebookLMPipe -OutDir $outDir `
            -OwnerUsername $ownerUsername `
            -ShortCode $shortCode `
            -NotebookName $NotebookName `
            -AutoPodcast $AutoPodcast `
            -BriefMd $briefMd `
            -RecipeMd $recipeMd `
            -TranscriptTxt $transcriptTxt
        if ($nb.ok) {
            $notebookOk        = $true
            $notebookUrl       = $nb.notebookUrl
            $notebookPodcastId = $nb.podcastId

            # Append the URL to BRIEF.md (idempotent — strip any prior block first)
            try {
                $existing = Get-Content -Path $briefMd -Raw -Encoding utf8
                $stripped = $existing -replace '(?ms)\r?\n## NotebookLM\r?\n.*$', ''
                $podcastLine = if ($notebookPodcastId) {
                    "`n- Audio Overview queued: $notebookPodcastId"
                } else { '' }
                $stripped += "`n## NotebookLM`n`n- Notebook: $notebookUrl$podcastLine`n"
                $stripped | Set-Content -Path $briefMd -Encoding utf8
            } catch {
                Write-Warning "Could not append NotebookLM section to BRIEF.md: $($_.Exception.Message)"
            }

            # Re-write manifest.json with the new URL field
            try {
                $manifestObj = Get-Content -Path $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json
                # ConvertFrom-Json returns a PSCustomObject; rebuild as ordered hashtable to preserve key order
                $rebuild = [ordered]@{}
                foreach ($prop in $manifestObj.PSObject.Properties) {
                    $rebuild[$prop.Name] = $prop.Value
                }
                $rebuild['notebooklm_url'] = $notebookUrl
                if ($notebookPodcastId) { $rebuild['notebooklm_podcast_id'] = $notebookPodcastId }
                $rebuild | ConvertTo-Json -Depth 6 | Set-Content -Path $manifestPath -Encoding utf8
            } catch {
                Write-Warning "Could not write notebooklm_url into manifest.json: $($_.Exception.Message)"
            }
        }
    }

    # --- ARCHIVE update (v3.1 Feature B) ---
    if (-not $NoArchive) {
        & $Step "Updating ARCHIVE..."
        try {
            Update-Archive -DossierFolder $outDir -OwnerUsername $ownerUsername -ShortCode $shortCode -RebuildArchive:$RebuildArchive
        } catch {
            Write-Host "  archive update failed: $_" -ForegroundColor Yellow
        }
    }

    # --- HTML brief (upgrade E) — rendered LAST so it captures the optional
    #     "## NotebookLM" section that NotebookLM auto-pipe may have appended.
    & $Step "Rendering index.html ..."
    Write-DossierHtml -OutPath $htmlPath `
        -OutDir $outDir `
        -OriginalUrl $OriginalUrl `
        -Platform $platform `
        -OwnerUsername $ownerUsername `
        -ShortCode $shortCode `
        -Caption $captionPreview `
        -Likes $likesStr -Views $viewsStr -Comments $commsStr `
        -Timestamp $Post.timestamp `
        -DisplayUrl $Post.displayUrl `
        -ProfileName $pName -ProfileBio $pBio -ProfileFollowers $pFollow -ProfilePosts $pPosts -ProfileUrl $pUrl `
        -TranscriptPath $(if ($transcriptOk) { $transcriptTxt } else { $null }) `
        -FramesDir $framesDir -FrameCount $frameCount `
        -VideoPath $videoPath

    # --- Auto-open HTML ---
    if ($DoOpen -and (Test-Path $htmlPath)) {
        $browser = Get-DefaultBrowserExe
        if ($browser) {
            try { Start-Process -FilePath $browser -ArgumentList "`"$htmlPath`"" } catch { Write-Warning "Could not auto-open $htmlPath : $($_.Exception.Message)" }
        } else {
            try { Start-Process $htmlPath } catch { Write-Warning "Could not auto-open $htmlPath : $($_.Exception.Message)" }
        }
    }

    return @{
        outDir          = $outDir
        frameCount      = $frameCount
        audioOk         = $audioOk
        transcriptOk    = $transcriptOk
        transcriptionReason = $transcriptionReason
        profileOk       = $profileOk
        profileError    = $profileError
        tourRan         = $tourRan
        recipeRan       = $recipeRan
        notebookOk      = $notebookOk
        notebookUrl     = $notebookUrl
        notebookPodcastId = $notebookPodcastId
        briefMd         = $briefMd
        htmlPath        = $htmlPath
        platform        = $platform
        owner           = $ownerUsername
        shortCode       = $shortCode
    }
}

# =============================================================================
# HTML RENDERER (upgrade E)
# =============================================================================
function Write-DossierHtml {
    param(
        [string]$OutPath,
        [string]$OutDir,
        [string]$OriginalUrl,
        [string]$Platform,
        [string]$OwnerUsername,
        [string]$ShortCode,
        [string]$Caption,
        $Likes,$Views,$Comments,
        $Timestamp,
        $DisplayUrl,
        $ProfileName,$ProfileBio,$ProfileFollowers,$ProfilePosts,$ProfileUrl,
        $TranscriptPath,
        [string]$FramesDir,
        [int]$FrameCount,
        [string]$VideoPath
    )

    # Frame thumbnails (relative paths, since the HTML lives in $OutDir)
    $frameTags = @()
    $frames = Get-ChildItem -Path $FramesDir -Filter 'f*.png' -File | Sort-Object Name
    foreach ($f in $frames) {
        $rel = "frames/$($f.Name)"
        $frameTags += "<a href=`"$rel`" target=`"_blank`"><img src=`"$rel`" alt=`"$($f.Name)`" loading=`"lazy`" /></a>"
    }
    $frameGrid = $frameTags -join "`n"

    # Transcript preview
    $transcriptHtml = if ($TranscriptPath -and (Test-Path $TranscriptPath)) {
        $raw = Get-Content -Path $TranscriptPath -Raw -Encoding utf8
        if ($raw.Length -gt 4000) { $raw = $raw.Substring(0, 4000) + "`n... (truncated, see transcript.txt for full)" }
        # HTML-escape
        ($raw -replace '&','&amp;' -replace '<','&lt;' -replace '>','&gt;')
    } else {
        '<em>no transcript</em>'
    }

    # Caption HTML-escape
    $captionHtml = ($Caption -replace '&','&amp;' -replace '<','&lt;' -replace '>','&gt;')

    # Avatar — best effort: use displayUrl if it's an image
    $avatarTag = if ($DisplayUrl) {
        "<img class=`"avatar`" src=`"$DisplayUrl`" alt=`"thumb`" loading=`"lazy`" />"
    } else { '<div class="avatar avatar-placeholder">[no thumb]</div>' }

    # Portfolio link (if available)
    $portfolioLink = if ($ProfileUrl) {
        "<a class=`"btn`" href=`"$ProfileUrl`" target=`"_blank`">$ProfileUrl</a>"
    } else { '<span class="muted">none in bio</span>' }

    # Video filename for embedding
    $videoFile = Split-Path -Leaf $VideoPath

    # Platform badge color hint
    $platformLabel = switch ($Platform) {
        'instagram' { 'INSTAGRAM' }
        'tiktok'    { 'TIKTOK' }
        'youtube'   { 'YOUTUBE SHORTS' }
        default     { ([string]$Platform).ToUpper() }
    }

    $html = @"
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Dossier - @$OwnerUsername - $ShortCode</title>
<style>
  :root {
    --bg: #0b0d10;
    --bg-card: #14171c;
    --bg-elev: #1b1f26;
    --fg: #e8eaed;
    --fg-muted: #9aa3ad;
    --accent: #7cdbff;
    --accent-2: #f6c177;
    --border: #242932;
    --mono: ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { background: var(--bg); color: var(--fg); margin: 0; padding: 0; font-family: var(--sans); line-height: 1.55; }
  a { color: var(--accent); text-decoration: none; border-bottom: 1px dotted color-mix(in srgb, var(--accent) 50%, transparent); }
  a:hover { color: var(--fg); border-bottom-color: var(--fg); }
  .container { max-width: 1100px; margin: 0 auto; padding: 48px 24px 96px; }
  .badge { display: inline-block; font-family: var(--mono); font-size: 11px; letter-spacing: 0.12em; padding: 4px 10px; background: var(--bg-elev); border: 1px solid var(--border); border-radius: 999px; color: var(--fg-muted); text-transform: uppercase; }
  .hero { display: grid; grid-template-columns: 96px 1fr; gap: 24px; align-items: center; padding-bottom: 32px; border-bottom: 1px solid var(--border); margin-bottom: 40px; }
  .avatar { width: 96px; height: 96px; border-radius: 12px; object-fit: cover; background: var(--bg-elev); border: 1px solid var(--border); }
  .avatar-placeholder { display: flex; align-items: center; justify-content: center; color: var(--fg-muted); font-family: var(--mono); font-size: 11px; }
  h1 { margin: 0 0 8px; font-size: 28px; font-weight: 600; letter-spacing: -0.01em; }
  h1 .at { color: var(--accent); }
  h2 { margin: 48px 0 16px; font-size: 14px; font-family: var(--mono); text-transform: uppercase; letter-spacing: 0.16em; color: var(--fg-muted); border-top: 1px solid var(--border); padding-top: 32px; }
  h2:first-of-type { border-top: none; padding-top: 0; }
  .meta { font-family: var(--mono); font-size: 13px; color: var(--fg-muted); }
  .meta .sep { padding: 0 10px; opacity: 0.4; }
  .stat { color: var(--fg); }
  .card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; padding: 20px 24px; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 720px) { .grid-2 { grid-template-columns: 1fr; } }
  .muted { color: var(--fg-muted); }
  pre, code { font-family: var(--mono); font-size: 13px; }
  pre { background: var(--bg-elev); border: 1px solid var(--border); border-radius: 8px; padding: 16px; overflow-x: auto; white-space: pre-wrap; word-wrap: break-word; }
  .frame-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
  .frame-grid img { width: 100%; height: auto; display: block; border-radius: 6px; border: 1px solid var(--border); transition: transform 120ms, border-color 120ms; }
  .frame-grid a { border: none; }
  .frame-grid img:hover { transform: scale(1.02); border-color: var(--accent); }
  video { width: 100%; max-width: 540px; display: block; border-radius: 12px; border: 1px solid var(--border); background: black; }
  .btn { display: inline-block; font-family: var(--mono); font-size: 12px; padding: 8px 14px; border: 1px solid var(--border); border-radius: 8px; color: var(--fg); background: var(--bg-elev); }
  .btn:hover { border-color: var(--accent); color: var(--accent); }
  .footer { margin-top: 80px; padding-top: 24px; border-top: 1px solid var(--border); color: var(--fg-muted); font-family: var(--mono); font-size: 11px; }
  ul.profile-list { list-style: none; padding: 0; margin: 0; }
  ul.profile-list li { padding: 8px 0; border-bottom: 1px solid var(--border); display: flex; gap: 16px; }
  ul.profile-list li:last-child { border-bottom: none; }
  ul.profile-list li .label { color: var(--fg-muted); font-family: var(--mono); font-size: 12px; min-width: 100px; text-transform: uppercase; letter-spacing: 0.1em; }
  ul.profile-list li .value { color: var(--fg); }
</style>
</head>
<body>
<div class="container">
  <div class="hero">
    $avatarTag
    <div>
      <span class="badge">$platformLabel - $ShortCode</span>
      <h1><span class="at">@</span>$OwnerUsername</h1>
      <div class="meta">
        <a href="$OriginalUrl" target="_blank">$OriginalUrl</a>
      </div>
      <div class="meta" style="margin-top:6px;">
        <span class="stat">$Likes</span> likes
        <span class="sep">|</span>
        <span class="stat">$Views</span> views
        <span class="sep">|</span>
        <span class="stat">$Comments</span> comments
        <span class="sep">|</span>
        <span>$Timestamp</span>
      </div>
    </div>
  </div>

  <h2>Caption</h2>
  <div class="card"><pre>$captionHtml</pre></div>

  <div class="grid-2" style="margin-top: 16px;">
    <div>
      <h2>Creator profile</h2>
      <div class="card">
        <ul class="profile-list">
          <li><span class="label">Name</span><span class="value">$ProfileName</span></li>
          <li><span class="label">Bio</span><span class="value">$ProfileBio</span></li>
          <li><span class="label">Followers</span><span class="value">$ProfileFollowers</span></li>
          <li><span class="label">Posts</span><span class="value">$ProfilePosts</span></li>
          <li><span class="label">Portfolio</span><span class="value">$portfolioLink</span></li>
        </ul>
      </div>
    </div>
    <div>
      <h2>Source video</h2>
      <video controls preload="metadata"><source src="$videoFile" type="video/mp4"></video>
    </div>
  </div>

  <h2>Transcript</h2>
  <div class="card"><pre>$transcriptHtml</pre></div>

  <h2>Frames ($FrameCount @ 1fps)</h2>
  <div class="frame-grid">
    $frameGrid
  </div>

  <div class="footer">
    Generated by dossier.ps1 v3 - $OutDir
  </div>
</div>
</body>
</html>
"@
    $html | Set-Content -Path $OutPath -Encoding utf8
}

# =============================================================================
# WATCHLIST DIGEST RENDERER
# =============================================================================
function Write-WatchDigestHtml {
    param(
        [string]$OutPath,
        [string]$DateStr,
        [array]$Entries  # array of @{ user; shortCode; folder; caption; url }
    )
    $rows = @()
    foreach ($e in $Entries) {
        $cap = if ($e.caption) { ($e.caption -replace '&','&amp;' -replace '<','&lt;' -replace '>','&gt;') } else { '' }
        if ($cap.Length -gt 200) { $cap = $cap.Substring(0,200) + '...' }
        $relIndex = if ($e.folder) { Join-Path $e.folder 'index.html' } else { $null }
        $folderLink = if ($relIndex -and (Test-Path $relIndex)) { "<a href=`"file:///$($relIndex -replace '\\','/')`">$($e.shortCode)</a>" } else { $e.shortCode }
        $rows += "<tr><td class=`"user`">@$($e.user)</td><td>$folderLink</td><td><a href=`"$($e.url)`" target=`"_blank`">post</a></td><td class=`"cap`">$cap</td></tr>"
    }
    $rowsHtml = $rows -join "`n"

    $html = @"
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Watchlist digest - $DateStr</title>
<style>
  :root { --bg:#0b0d10; --fg:#e8eaed; --muted:#9aa3ad; --accent:#7cdbff; --border:#242932; --bg-card:#14171c; --mono: ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace; --sans: -apple-system, "Inter", system-ui, sans-serif; }
  * { box-sizing: border-box; }
  body { background:var(--bg); color:var(--fg); font-family:var(--sans); line-height:1.55; margin:0; }
  .container { max-width: 1100px; margin: 0 auto; padding: 48px 24px; }
  h1 { font-size: 28px; letter-spacing:-0.01em; margin: 0 0 8px; }
  .badge { display:inline-block; font-family:var(--mono); font-size:11px; letter-spacing:0.12em; padding:4px 10px; background:var(--bg-card); border:1px solid var(--border); border-radius:999px; color:var(--muted); text-transform:uppercase; }
  table { width: 100%; border-collapse: collapse; margin-top:32px; }
  th, td { text-align:left; padding:12px 16px; border-bottom:1px solid var(--border); vertical-align: top; }
  th { font-family:var(--mono); font-size:11px; letter-spacing:0.16em; text-transform:uppercase; color:var(--muted); font-weight:500; }
  td.user { font-family: var(--mono); color: var(--accent); }
  td.cap { color: var(--muted); font-size: 14px; max-width: 480px; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { color: var(--fg); }
</style>
</head>
<body>
<div class="container">
  <span class="badge">Watchlist digest</span>
  <h1>$DateStr - $($Entries.Count) new posts</h1>
  <table>
    <thead><tr><th>User</th><th>Dossier</th><th>Original</th><th>Caption</th></tr></thead>
    <tbody>
$rowsHtml
    </tbody>
  </table>
</div>
</body>
</html>
"@
    $html | Set-Content -Path $OutPath -Encoding utf8
}

# =============================================================================
# RUN-FROM-URL — orchestrates one URL through detection -> cache -> scrape -> pipeline.
# Returns hashtable: @{ status='succeeded'|'failed'|'cached'; folder=...; reason=... }
# =============================================================================
function Invoke-DossierForUrl {
    param(
        [string]$Url,
        [hashtable]$Whisper,
        [bool]$DoTour,
        [bool]$DoRecipe,
        [bool]$DoOpen,
        [bool]$ForceFlag,

        # v3.1 Feature A
        [bool]$DoNotebookLM = $true,
        [string]$NotebookName,
        [bool]$AutoPodcast = $false,

        # v3.1 Feature B
        [bool]$NoArchive = $false,
        [bool]$RebuildArchive = $false
    )

    $info = Get-PlatformInfo -Url $Url
    if (-not $info) {
        return @{ status='failed'; folder=$null; reason="unsupported URL pattern: $Url" }
    }

    # Smart cache (upgrade D)
    $cached = Find-CachedDossier -Id $info.Id -Force:$ForceFlag
    if ($cached) {
        Write-Host "Cached ($($cached.AgeHours)h ago) - skipping. Use -Force to re-fetch." -ForegroundColor Yellow
        Write-Host "  Folder: $($cached.Path)" -ForegroundColor DarkGray
        return @{ status='cached'; folder=$cached.Path; reason="cache age $($cached.AgeHours)h" }
    }

    # Scrape per-platform
    $post = $null
    try {
        switch ($info.Platform) {
            'instagram' { $post = Get-InstagramPost -Url $Url }
            'tiktok'    { $post = Get-TikTokPost -Url $Url }
            'youtube' {
                # For YT we want yt-dlp to drop the file directly into the dossier folder.
                # Use a temp path then move once the folder exists.
                $tempVid = Join-Path $env:TEMP "dossier-yt-$($info.Id).mp4"
                $post = Get-YouTubeShort -Url $Url -DownloadPath $tempVid
            }
        }
    } catch {
        return @{ status='failed'; folder=$null; reason="scrape failed: $($_.Exception.Message)" }
    }

    # Pipeline
    try {
        $result = Invoke-DossierPipeline -Post $post `
            -OriginalUrl $Url `
            -Whisper $Whisper `
            -DoTour:$DoTour `
            -DoRecipe:$DoRecipe `
            -DoOpen:$DoOpen `
            -DoNotebookLM:$DoNotebookLM `
            -NotebookName $NotebookName `
            -AutoPodcast:$AutoPodcast `
            -NoArchive:$NoArchive `
            -RebuildArchive:$RebuildArchive
        return @{ status='succeeded'; folder=$result.outDir; result=$result }
    } catch {
        return @{ status='failed'; folder=$null; reason="pipeline failed: $($_.Exception.Message)" }
    }
}

# =============================================================================
# WATCHLIST (upgrade F)
# =============================================================================
function Resolve-WatchInput {
    param([string]$WatchInput)
    if (-not $WatchInput) { return @() }
    if (Test-Path $WatchInput) {
        return Get-Content -Path $WatchInput -Encoding utf8 |
            Where-Object { $_ -and ($_ -notmatch '^\s*#') } |
            ForEach-Object { ($_ -replace '^@','').Trim() } |
            Where-Object { $_ }
    }
    return $WatchInput.Split(',') | ForEach-Object { ($_ -replace '^@','').Trim() } | Where-Object { $_ }
}

function Invoke-WatchlistRun {
    param(
        [string]$WatchInput,
        [hashtable]$Whisper,
        [bool]$DoTour,
        [bool]$DoRecipe,
        [bool]$ForceFlag,

        # v3.1 Feature A
        [bool]$DoNotebookLM = $true,
        [string]$NotebookName,
        [bool]$AutoPodcast = $false,

        # v3.1 Feature B
        [bool]$NoArchive = $false,
        [bool]$RebuildArchive = $false
    )

    $users = Resolve-WatchInput -WatchInput $WatchInput
    if ($users.Count -eq 0) {
        Write-Host "No usernames found in -Watch input." -ForegroundColor Red
        exit 32
    }
    Write-Host "Watchlist: $($users.Count) user(s) - $(($users -join ', '))" -ForegroundColor Cyan

    # Load existing watchlist cache (last seen shortcodes per user)
    $watchData = @{}
    if (Test-Path $Script:WatchCache) {
        try {
            $obj = Get-Content -Path $Script:WatchCache -Raw | ConvertFrom-Json -AsHashtable
            if ($obj) { $watchData = $obj }
        } catch {
            Write-Warning "Could not read $Script:WatchCache - starting fresh."
            $watchData = @{}
        }
    }

    $newEntries = @()

    foreach ($u in $users) {
        Write-Host ""
        Write-Host "=== @$u ===" -ForegroundColor Cyan
        try {
            $items = Invoke-ApifyActor -ActorId 'apify~instagram-profile-scraper' -InputBody @{
                usernames = @($u)
            }
        } catch {
            Write-Warning "Profile scrape failed for @$u : $($_.Exception.Message). Skipping."
            continue
        }
        if (-not $items -or $items.Count -eq 0) {
            Write-Warning "No profile data for @$u. Skipping."
            continue
        }
        $p = $items[0]
        $latest = if ($p.latestPosts) { $p.latestPosts } elseif ($p.posts) { $p.posts } else { @() }
        if ($latest.Count -eq 0) {
            Write-Host "  No latest posts on profile. Skipping." -ForegroundColor DarkGray
            continue
        }

        $lastSeen = $watchData[$u]
        $newPosts = @()
        foreach ($lp in $latest) {
            $sc = $lp.shortCode
            if (-not $sc) { continue }
            if ($lastSeen -and $sc -eq $lastSeen) { break }
            $newPosts += $lp
        }

        if ($newPosts.Count -eq 0) {
            Write-Host "  No new posts since last scan." -ForegroundColor DarkGray
            continue
        }

        Write-Host "  $($newPosts.Count) new post(s) detected." -ForegroundColor Green

        $allSucceeded = $true
        foreach ($lp in $newPosts) {
            $postUrl = $lp.url
            if (-not $postUrl) { $postUrl = "https://www.instagram.com/p/$($lp.shortCode)/" }
            Write-Host "  -> Running dossier on $postUrl" -ForegroundColor DarkGray
            $r = Invoke-DossierForUrl -Url $postUrl -Whisper $Whisper `
                -DoTour:$DoTour -DoRecipe:$DoRecipe -DoOpen:$false -ForceFlag:$ForceFlag `
                -DoNotebookLM:$DoNotebookLM -NotebookName $NotebookName -AutoPodcast:$AutoPodcast `
                -NoArchive:$NoArchive -RebuildArchive:$RebuildArchive
            $newEntries += @{
                user      = $u
                shortCode = $lp.shortCode
                url       = $postUrl
                caption   = $lp.caption
                folder    = $r.folder
                status    = $r.status
            }
            if ($r.status -ne 'succeeded' -and $r.status -ne 'cached') {
                $allSucceeded = $false
            }
        }

        # Advance cursor only on full success; otherwise failed posts get silently
        # skipped next run. Cache makes retrying the successes cheap.
        if ($allSucceeded) {
            $watchData[$u] = $latest[0].shortCode
        } else {
            Write-Host "  Some posts failed; cursor not advanced (will retry next run)." -ForegroundColor Yellow
        }
    }

    # Persist the watchlist cache
    $watchData | ConvertTo-Json -Depth 4 | Set-Content -Path $Script:WatchCache -Encoding utf8

    # Write digest files
    $today = Get-Date -Format 'yyyy-MM-dd'
    $digestMd   = Join-Path $Script:VideoMemRoot "WATCH-DIGEST-$today.md"
    $digestHtml = Join-Path $Script:VideoMemRoot "WATCH-DIGEST-$today.html"

    $mdLines = @("# Watchlist digest - $today", "")
    if ($newEntries.Count -eq 0) {
        $mdLines += "_No new posts from your watchlist today._"
    } else {
        $mdLines += "$($newEntries.Count) new post(s):"
        $mdLines += ""
        foreach ($e in $newEntries) {
            $folderStr = if ($e.folder) { $e.folder } else { '(no folder - ' + $e.status + ')' }
            $mdLines += "- **@$($e.user)** [$($e.shortCode)]($($e.url)) - $folderStr"
        }
    }
    ($mdLines -join "`n") | Set-Content -Path $digestMd -Encoding utf8
    Write-WatchDigestHtml -OutPath $digestHtml -DateStr $today -Entries $newEntries

    Write-Host ""
    Write-Host "Watchlist digest written:" -ForegroundColor Green
    Write-Host "  $digestMd" -ForegroundColor Green
    Write-Host "  $digestHtml" -ForegroundColor Green

    # Auto-open digest HTML (mirrors -OpenArchive pattern; uses Get-DefaultBrowserExe).
    # Soft-fails so scheduled-task runs without an interactive session don't error.
    if (Test-Path $digestHtml) {
        $browser = Get-DefaultBrowserExe
        if ($browser) {
            try { Start-Process -FilePath $browser -ArgumentList "`"$digestHtml`"" } catch {}
        } else {
            try { Start-Process $digestHtml } catch {}
        }
    }
}

function Install-WatchTask {
    param(
        [string]$WatchInput,
        [string]$TimeStr
    )
    if (-not $WatchInput) {
        Write-Host "-InstallWatchTask requires -Watch <users.txt or comma-list>" -ForegroundColor Red
        exit 1
    }
    if ($TimeStr -notmatch '^\d{2}:\d{2}$') {
        Write-Host "-Time must be HH:mm (24h). Got: $TimeStr" -ForegroundColor Red
        exit 1
    }
    $scriptPath = $PSCommandPath
    if (-not $scriptPath) { $scriptPath = $MyInvocation.MyCommand.Path }
    # Quote the WatchInput in case it contains commas / spaces
    $argList = "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -Watch `"$WatchInput`""
    $action = New-ScheduledTaskAction -Execute 'pwsh.exe' -Argument $argList
    $trigger = New-ScheduledTaskTrigger -Daily -At $TimeStr
    $taskName = 'DossierWatchlistDaily'
    try {
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Description "Daily dossier watchlist scan" -Force | Out-Null
        Write-Host "Scheduled task '$taskName' registered. Runs daily at $TimeStr." -ForegroundColor Green
        Write-Host "  Watch input: $WatchInput" -ForegroundColor DarkGray
        Write-Host "  Inspect: Get-ScheduledTask -TaskName $taskName" -ForegroundColor DarkGray
        Write-Host "  Remove:  Unregister-ScheduledTask -TaskName $taskName -Confirm:`$false" -ForegroundColor DarkGray

        # Also register META refresh task — runs 5 minutes BEFORE the watchlist
        $metaTime = ([datetime]::ParseExact($TimeStr, 'HH:mm', $null)).AddMinutes(-5).ToString('HH:mm')
        $metaAction = New-ScheduledTaskAction -Execute "pwsh.exe" -Argument "-NoProfile -File `"$scriptPath`" -UpdateMeta"
        $metaTrigger = New-ScheduledTaskTrigger -Daily -At $metaTime
        Register-ScheduledTask -TaskName "DossierMetaRefreshDaily" -Action $metaAction -Trigger $metaTrigger -Force | Out-Null
        Write-Host "Registered DossierMetaRefreshDaily at $metaTime (5min before watchlist at $TimeStr)" -ForegroundColor Green
    } catch {
        Write-Host "Failed to register scheduled task: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "(May require running as admin.)" -ForegroundColor Yellow
        exit 1
    }
}

# =============================================================================
# BATCH MODE (upgrade C)
# =============================================================================
function Invoke-BatchRun {
    param(
        [string]$ListFile,
        [hashtable]$Whisper,
        [bool]$DoTour,
        [bool]$DoRecipe,
        [bool]$ForceFlag,
        [int]$MaxJobs,

        # v3.1 Feature A
        [bool]$DoNotebookLM = $true,
        [string]$NotebookName,
        [bool]$AutoPodcast = $false,

        # v3.1 Feature B
        [bool]$NoArchive = $false,
        [bool]$RebuildArchive = $false
    )

    if (-not (Test-Path $ListFile)) {
        Write-Host "Batch list file not found: $ListFile" -ForegroundColor Red
        exit 30
    }
    $lines = Get-Content -Path $ListFile -Encoding utf8 |
        Where-Object { $_ -and ($_ -notmatch '^\s*#') } |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ }
    if ($lines.Count -eq 0) {
        Write-Host "Batch list is empty (or only comments): $ListFile" -ForegroundColor Red
        exit 30
    }

    # Deduplicate by canonical platform+id so two URL forms for the same post
    # (e.g. /reel/X vs /reels/X vs /p/X) can't run concurrently and clobber
    # the shared output folder.
    $dedupSeen = @{}
    $dedupedLines = @()
    foreach ($l in $lines) {
        $info = Get-PlatformInfo -Url $l
        if (-not $info) {
            # Couldn't parse — pass through unchanged; child will reject if invalid.
            $dedupedLines += $l
            continue
        }
        $key = "$($info.Platform):$($info.Id)"
        if ($dedupSeen.ContainsKey($key)) {
            Write-Host "  [batch] skipping duplicate ($key): $l" -ForegroundColor DarkGray
            continue
        }
        $dedupSeen[$key] = $true
        $dedupedLines += $l
    }
    if ($dedupedLines.Count -lt $lines.Count) {
        Write-Host "Batch deduplicated: $($lines.Count) -> $($dedupedLines.Count) unique URL(s)" -ForegroundColor DarkGray
    }
    $lines = $dedupedLines

    Write-Host "Batch mode: $($lines.Count) URL(s), max $MaxJobs in parallel" -ForegroundColor Cyan
    Write-Host ""

    # We use Start-Job. Each job re-launches dossier.ps1 -Url <url> with -NoOpen
    # (so we don't open N browser tabs at once).
    $scriptPath = $PSCommandPath
    if (-not $scriptPath) { $scriptPath = $MyInvocation.MyCommand.Path }

    $jobs = @()
    $results = @()
    $i = 0
    foreach ($line in $lines) {
        # Wait until under MaxJobs
        while ((@($jobs | Where-Object { $_.State -eq 'Running' })).Count -ge $MaxJobs) {
            Start-Sleep -Milliseconds 500
        }
        $i++
        Write-Host "  [batch $i/$($lines.Count)] launching $line" -ForegroundColor DarkGray
        $argList = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$scriptPath, '-Url', $line, '-NoOpen')
        if ($ForceFlag) { $argList += '-Force' }
        if (-not $DoTour) { $argList += '-NoTour' }
        if (-not $DoRecipe) { $argList += '-NoRecipe' }
        if (-not $DoNotebookLM) { $argList += '-NoNotebookLM' }
        if ($NotebookName) { $argList += @('-Notebook', $NotebookName) }
        if ($AutoPodcast) { $argList += '-AutoPodcast' }
        # Children always skip archive — parent serializes archive updates after
        # all children finish, to avoid concurrent writes to ARCHIVE/index.html
        # and FROM-CLAUDE.md. -RebuildArchive is also handled once in the parent.
        $argList += '-NoArchive'
        $j = Start-Job -ScriptBlock {
            param($pwshArgs, $url)
            try {
                $stdout = (& pwsh @pwshArgs 2>&1 | Out-String)
                [pscustomobject]@{ url = $url; exit = $LASTEXITCODE; stdout = $stdout }
            } catch {
                [pscustomobject]@{ url = $url; exit = -1; stdout = ''; error = $_.Exception.Message }
            }
        } -ArgumentList $argList, $line
        $jobs += $j
    }

    Write-Host ""
    Write-Host "Waiting for $($jobs.Count) job(s) to finish..." -ForegroundColor Cyan
    $jobs | Wait-Job | Out-Null
    foreach ($j in $jobs) {
        $out = Receive-Job -Job $j
        $results += $out
        Remove-Job -Job $j | Out-Null
    }

    # Determine status per URL: we don't have direct return values from the child
    # process, so we infer from exit code + folder existence.
    $today = Get-Date -Format 'yyyy-MM-dd'
    $summary = @("# Batch summary - $today", "", "Source list: $ListFile", "", "| URL | Status | Folder |", "|---|---|---|")
    $countOk = 0; $countFail = 0; $countCached = 0
    foreach ($r in $results) {
        $url = $r.url
        $info = Get-PlatformInfo -Url $url
        $folder = $null
        $status = 'failed'
        if ($info) {
            $existing = Find-CachedDossier -Id $info.Id   # any folder with that id
            if (-not $existing -and (Test-Path $Script:VideoMemRoot)) {
                # Sort newest-first; -Force or older retained runs can leave
                # multiple folders for the same id, and we want this run's.
                $cand = Get-ChildItem -Path $Script:VideoMemRoot -Directory -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name -match "_$($info.Id)$" } |
                    Sort-Object LastWriteTime -Descending |
                    Select-Object -First 1
                if ($cand) { $folder = $cand.FullName }
            } elseif ($existing) {
                $folder = $existing.Path
            }
        }
        # Use exit code as primary success signal; folder alone could be from a
        # prior cached run, which would falsely report this run as succeeded.
        if ($r.exit -eq 0 -and $folder -and (Test-Path (Join-Path $folder 'manifest.json'))) {
            # Detect cache vs fresh by inspecting the child run's stdout.
            if ($r.stdout -and ($r.stdout -match 'Cached \(\d+h ago\)')) {
                $status = 'cached'; $countCached++
            } else {
                $status = 'succeeded'; $countOk++
            }
        } else {
            $status = 'failed'; $countFail++
        }
        $folderStr = if ($folder) { $folder } else { '_n/a_' }
        $summary += "| $url | $status | $folderStr |"
    }
    $summary += ""
    $summary += "**Totals:** $countOk succeeded, $countCached cached, $countFail failed"
    $summaryPath = Join-Path $Script:VideoMemRoot "BATCH-SUMMARY-$today.md"
    ($summary -join "`n") | Set-Content -Path $summaryPath -Encoding utf8

    # Now that all children are done, run archive updates serially in the
    # parent. Children passed -NoArchive, so this is the only writer and
    # nothing contends for ARCHIVE/index.html or FROM-CLAUDE.md.
    if (-not $NoArchive) {
        if ($RebuildArchive) {
            $archiveDir = Join-Path $Script:VideoMemRoot 'ARCHIVE'
            if (Test-Path $archiveDir) {
                Write-Host ""
                Write-Host "[archive] -RebuildArchive: wiping index.html + SIGNATURES once before serial rebuild..." -ForegroundColor Yellow
                $idx = Join-Path $archiveDir 'index.html'
                if (Test-Path $idx) { Remove-Item $idx -Force }
                $sigs = Join-Path $archiveDir 'SIGNATURES'
                if (Test-Path $sigs) { Remove-Item $sigs -Recurse -Force }
            }
        }
        foreach ($r in $results) {
            if ($r.exit -ne 0) { continue }
            $info = Get-PlatformInfo -Url $r.url
            if (-not $info) { continue }
            # Most recent folder first — guards against attaching to an older
            # retained run when -Force or prior runs left siblings.
            $cand = Get-ChildItem -Path $Script:VideoMemRoot -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match "_$($info.Id)$" } |
                Sort-Object LastWriteTime -Descending |
                Select-Object -First 1
            if (-not $cand) { continue }
            # Use canonical owner_username from manifest, not the sanitized
            # safeUser embedded in the folder name. Update-CreatorSignature
            # filters by manifest username, so a sanitized value would silently
            # misattribute (or drop) the dossier.
            $manifestPath = Join-Path $cand.FullName 'manifest.json'
            if (-not (Test-Path $manifestPath)) {
                Write-Host "  [archive] no manifest.json in $($cand.Name); skipping" -ForegroundColor Yellow
                continue
            }
            $owner = $null
            try {
                $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
                $owner = $manifest.owner_username
            } catch {
                Write-Host "  [archive] could not parse manifest in $($cand.Name): $_" -ForegroundColor Yellow
                continue
            }
            if (-not $owner) {
                Write-Host "  [archive] manifest missing owner_username in $($cand.Name); skipping" -ForegroundColor Yellow
                continue
            }
            try {
                Update-Archive -DossierFolder $cand.FullName -OwnerUsername $owner -ShortCode $info.Id
            } catch {
                Write-Host "  [archive] update failed for $($cand.Name): $_" -ForegroundColor Yellow
            }
        }
    }

    Write-Host ""
    Write-Host "Batch complete: $countOk ok, $countCached cached, $countFail failed" -ForegroundColor Green
    Write-Host "  Summary: $summaryPath" -ForegroundColor Green
}

# =============================================================================
# MAIN DISPATCH
# =============================================================================

# === MODE: -UpdateMeta ===
if ($UpdateMeta) {
    Write-Host "Refreshing META.md -- this takes ~3 minutes" -ForegroundColor Cyan

    $claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
    if (-not $claudeCmd) {
        Write-Host "claude CLI required for -UpdateMeta. Install: https://docs.anthropic.com/claude-code" -ForegroundColor Red
        exit 50
    }

    if (-not (Test-FirecrawlTokenLooksValid $env:FIRECRAWL_API_KEY)) {
        Read-FirecrawlTokenInteractive
    }

    $videoMemRoot = $Script:VideoMemRoot
    if (-not (Test-Path $videoMemRoot)) { New-Item -ItemType Directory -Path $videoMemRoot -Force | Out-Null }
    $metaPath = Join-Path $videoMemRoot 'META.md'
    $existingMeta = if (Test-Path $metaPath) { Get-Content $metaPath -Raw } else { "" }

    $promptAI = "Research current state of consumer AI tools as of TODAY $(Get-Date -Format 'yyyy-MM-dd'). Cover: Claude (Anthropic - current models, recent shipping, pricing), GPT/OpenAI (current models, image gen, video), Gemini (3.x current, free tier, multimodal), specialty tools (Claude Design, Cursor, v0, Bolt, Lovable, Cline, Aider). For each: current version, current pricing, what shipped in last 60 days, when to use it. Use web search. Output well-structured markdown with date-stamped sources."

    $promptStack = "Research current state of web/3D dev stack as of TODAY $(Get-Date -Format 'yyyy-MM-dd'). Cover: Next.js current version + recent breaking changes, Tailwind current, shadcn current, Three.js / React Three Fiber / drei current, GSAP / Framer Motion / Lenis current, Spline AI updates, Vercel platform updates. Use web search. Output well-structured markdown with date-stamped sources."

    $promptWorkflow = "Research current state of Claude Code, MCP servers, agent orchestration patterns as of TODAY $(Get-Date -Format 'yyyy-MM-dd'). Cover: new MCP servers in last 60 days, Claude Code feature updates, agent skill marketplace state, current best-practices from Anthropic blog + r/ClaudeAI + recent dev YouTube. Use web search. Output well-structured markdown with date-stamped sources."

    Write-Host "[1/4] Spawning 3 parallel research streams..." -ForegroundColor Cyan
    $j1 = Start-Job -ScriptBlock { param($p) & claude -p $p 2>&1 } -ArgumentList $promptAI
    $j2 = Start-Job -ScriptBlock { param($p) & claude -p $p 2>&1 } -ArgumentList $promptStack
    $j3 = Start-Job -ScriptBlock { param($p) & claude -p $p 2>&1 } -ArgumentList $promptWorkflow

    Write-Host "[2/4] Waiting for streams to complete..." -ForegroundColor Cyan
    Wait-Job -Job @($j1, $j2, $j3) | Out-Null
    $r1 = (Receive-Job $j1) -join "`n"
    $r2 = (Receive-Job $j2) -join "`n"
    $r3 = (Receive-Job $j3) -join "`n"
    # Capture state before Remove-Job destroys the job objects.
    $state1 = $j1.State; $state2 = $j2.State; $state3 = $j3.State
    Remove-Job -Job @($j1, $j2, $j3)

    # Empty streams would silently produce a degraded META.md that still looks
    # valid. Abort instead so the existing META.md (if any) stays untouched.
    $failedStreams = @()
    if ($state1 -ne 'Completed' -or [string]::IsNullOrWhiteSpace($r1)) { $failedStreams += 'AI Models' }
    if ($state2 -ne 'Completed' -or [string]::IsNullOrWhiteSpace($r2)) { $failedStreams += 'Build Stack' }
    if ($state3 -ne 'Completed' -or [string]::IsNullOrWhiteSpace($r3)) { $failedStreams += 'Workflow' }
    if ($failedStreams.Count -gt 0) {
        Write-Host ""
        Write-Host "Research stream(s) returned no usable output: $($failedStreams -join ', ')" -ForegroundColor Yellow
        Write-Host "Aborting META update; existing META.md is unchanged." -ForegroundColor Yellow
        exit 50
    }

    Write-Host "[3/4] Synthesizing into META.md..." -ForegroundColor Cyan
    $synthPrompt = @"
You are synthesizing 3 research streams into a unified META.md. Write the result to $metaPath. Use this exact structure:

# META — current AI/web/agent landscape

_Last updated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')_

## What changed since last refresh

(Compute a short delta from the previous version below if it existed; if no previous version exists, omit this section. Previous META content follows --- if empty, skip this section entirely.)
$(if ($existingMeta) { "`n--- PREVIOUS META ---`n$existingMeta`n--- END PREVIOUS ---`n" } else { "(No previous META.md)" })

## AI Models

(Synthesize stream 1 below into a clean section)

STREAM 1 (AI Models):
$r1

## Build Tools / Stack

(Synthesize stream 2)

STREAM 2 (Build Stack):
$r2

## Workflow / MCP / Agent

(Synthesize stream 3)

STREAM 3 (Workflow):
$r3

## Source URLs

(Deduplicate all date-stamped URLs from the 3 streams)

OVERWRITE $metaPath with the synthesized result. Be concrete; no fluff.
"@

    # Capture META state before synth so we can verify it was actually rewritten.
    $mtimeBefore = if (Test-Path $metaPath) { (Get-Item $metaPath).LastWriteTime } else { [datetime]::MinValue }

    $synthOut = & claude -p $synthPrompt 2>&1 | Out-String
    $synthExit = $LASTEXITCODE
    if ($synthExit -ne 0) {
        Write-Host "  First synth attempt exit=$synthExit, retrying with --dangerously-skip-permissions..." -ForegroundColor DarkGray
        $synthOut = & claude --dangerously-skip-permissions -p $synthPrompt 2>&1 | Out-String
        $synthExit = $LASTEXITCODE
    }

    # Validate synth actually produced a non-trivial, updated META.md before
    # we touch INDEX.md or claim success.
    $mtimeAfter = if (Test-Path $metaPath) { (Get-Item $metaPath).LastWriteTime } else { [datetime]::MinValue }
    $metaSize = if (Test-Path $metaPath) { (Get-Item $metaPath).Length } else { 0 }
    if ($synthExit -ne 0 -or $mtimeAfter -le $mtimeBefore -or $metaSize -lt 200) {
        Write-Host ""
        Write-Host "META synthesis failed validation:" -ForegroundColor Yellow
        Write-Host "  synth exit code: $synthExit (0 = ok)" -ForegroundColor DarkGray
        Write-Host "  META.md updated:  $($mtimeAfter -gt $mtimeBefore)" -ForegroundColor DarkGray
        Write-Host "  META.md size:     $metaSize bytes (need >200)" -ForegroundColor DarkGray
        if ($synthOut) {
            $tail = if ($synthOut.Length -gt 500) { $synthOut.Substring($synthOut.Length - 500) } else { $synthOut }
            Write-Host "  Synth output tail:" -ForegroundColor DarkGray
            Write-Host $tail -ForegroundColor DarkGray
        }
        Write-Host "Skipping INDEX.md update; existing META.md may be stale." -ForegroundColor Yellow
        exit 50
    }

    Write-Host "[4/4] Updating INDEX.md..." -ForegroundColor Cyan
    $indexPath = Join-Path $videoMemRoot 'INDEX.md'
    if (Test-Path $indexPath) {
        $indexContent = Get-Content $indexPath -Raw
        if ($indexContent -notmatch 'META\.md') {
            $insertion = "`n## 🧭 Current Meta`n`n**Read FIRST every session — this is the most time-sensitive file:**`n`n- ``META.md`` — current AI/tools/stack landscape, auto-refreshed daily`n"
            $newContent = $indexContent -replace '(?s)(## 🎯 If you read nothing else.*?\n\n)', "`$1$insertion`n"
            Set-Content -Path $indexPath -Value $newContent -Encoding UTF8
        }
    }

    Write-Host "META.md refreshed: $metaPath" -ForegroundColor Green
    exit 0
}

# === MODE: -ShowMeta ===
if ($ShowMeta) {
    $metaPath = Join-Path $Script:VideoMemRoot 'META.md'
    if (Test-Path $metaPath) {
        Get-Content $metaPath
    } else {
        Write-Host "No META.md yet -- run .\dossier.ps1 -UpdateMeta first." -ForegroundColor Yellow
    }
    exit 0
}

# Mode 0: -AnalyzeCreator <username> — standalone signature synthesis
if ($AnalyzeCreator) {
    if (-not (Test-Path $Script:VideoMemRoot)) {
        Write-Error "video-memory root not found at $Script:VideoMemRoot. Run at least one dossier first."
        exit 1
    }
    $cleanUser = $AnalyzeCreator -replace '^@',''
    Write-Host "Analyzing @$cleanUser ..." -ForegroundColor DarkGray
    Update-CreatorSignature -Username $cleanUser
    $sigPath = Join-Path $Script:VideoMemRoot "ARCHIVE\SIGNATURES\$cleanUser.md"
    if (Test-Path $sigPath) {
        Write-Host "Signature written: $sigPath" -ForegroundColor Green
    } else {
        Write-Warning "Signature not produced. Likely <3 dossiers for @$cleanUser, or claude CLI missing."
    }
    exit 0
}

# Mode 0b: -TechniqueNotebook <tag> — pipe all archive dossiers tagged with <tag>
# into a single technique-themed NotebookLM notebook.
if ($TechniqueNotebook) {
    $claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
    if (-not $claudeCmd) {
        Write-Error "claude CLI not on PATH. -TechniqueNotebook requires claude CLI for notebooklm-mcp."
        exit 1
    }
    if (-not (Test-Path $Script:VideoMemRoot)) {
        Write-Error "video-memory root not found at $Script:VideoMemRoot. Run at least one dossier first."
        exit 1
    }

    Write-Host "Collecting dossiers tagged '$TechniqueNotebook' ..." -ForegroundColor DarkGray
    $allDossiers = Get-ArchiveDossierData
    $matching = $allDossiers | Where-Object { $_.Tags -contains $TechniqueNotebook }

    if (-not $matching -or $matching.Count -eq 0) {
        Write-Warning "No dossiers tagged '$TechniqueNotebook' found. Available tags from your archive:"
        $available = ($allDossiers | ForEach-Object { $_.Tags } | Select-Object -Unique | Sort-Object) -join ', '
        Write-Host "  $available" -ForegroundColor DarkGray
        exit 1
    }

    Write-Host "Found $($matching.Count) dossier(s) tagged '$TechniqueNotebook'. Piping to NotebookLM ..." -ForegroundColor DarkGray
    $notebookName = "Technique: $TechniqueNotebook"
    $pipedCount = 0
    $idx = 0
    foreach ($d in $matching) {
        $idx++
        $briefPath      = Join-Path $d.Folder 'BRIEF.md'
        $recipePath     = Join-Path $d.Folder 'RECIPE.md'
        $transcriptPath = Join-Path $d.Folder 'transcript.txt'
        Write-Host "  [$idx/$($matching.Count)] @$($d.Username) / $($d.ShortCode)" -ForegroundColor DarkGray
        $r = Invoke-NotebookLMPipe `
            -OutDir $d.Folder `
            -OwnerUsername $d.Username `
            -ShortCode $d.ShortCode `
            -NotebookName $notebookName `
            -AutoPodcast $AutoPodcast `
            -BriefMd $briefPath `
            -RecipeMd $recipePath `
            -TranscriptTxt $transcriptPath
        if ($r.ok) { $pipedCount++ }
    }

    Write-Host "TechniqueNotebook '$TechniqueNotebook' complete: $pipedCount/$($matching.Count) sources piped." -ForegroundColor Green
    exit 0
}

# Mode 0c: -VerifyPost <url|shortCode>
if ($VerifyPost) {
    $claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
    if (-not $claudeCmd -and -not $env:ANTHROPIC_API_KEY) {
        Write-Error "-VerifyPost requires either claude CLI on PATH or ANTHROPIC_API_KEY set for native fallbacks."
        exit 1
    }
    if (-not (Test-Path $Script:VideoMemRoot)) {
        Write-Error "video-memory root not found at $Script:VideoMemRoot. Run at least one dossier first."
        exit 1
    }

    # Determine if $VerifyPost is a URL or a bare shortCode
    $isUrl = $VerifyPost -match '^https?://'
    $dossierFolder = $null

    if ($isUrl) {
        # Full pipeline: download + transcript + BRIEF, then V1/V2/V3
        Write-Host ""
        Write-Host "-VerifyPost: running download + transcript pipeline for $VerifyPost ..." -ForegroundColor Cyan
        if (-not (Test-ApifyTokenLooksValid -Token $env:APIFY_TOKEN)) { [void](Read-ApifyTokenInteractive) }
        if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
            Write-Error "ffmpeg not found on PATH. Install: winget install Gyan.FFmpeg"
            exit 3
        }
        $whisper = Get-WhisperBackend
        if ($whisper.Backend) { Write-Host "Whisper backend: $($whisper.Backend)" -ForegroundColor DarkGray }
        $pipeResult = Invoke-DossierForUrl -Url $VerifyPost -Whisper $whisper `
            -DoTour:$false -DoRecipe:$false -DoOpen:$false -ForceFlag:$Force `
            -DoNotebookLM:$false -NoArchive:$true -RebuildArchive:$false
        if ($pipeResult.status -eq 'failed') {
            Write-Error "Dossier pipeline failed: $($pipeResult.reason)"
            exit 1
        }
        $dossierFolder = $pipeResult.folder
        Write-Host "  Dossier folder: $dossierFolder" -ForegroundColor DarkGray
    } else {
        # ShortCode path: find existing dossier folder by matching _<shortCode> suffix
        $shortCodeIn = $VerifyPost.Trim()
        $candidates = Get-ChildItem -Path $Script:VideoMemRoot -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match "_${shortCodeIn}$" } |
            Sort-Object LastWriteTime -Descending
        if (-not $candidates -or $candidates.Count -eq 0) {
            Write-Error "No dossier folder found for shortCode '$shortCodeIn' under $Script:VideoMemRoot. Run the URL through dossier first."
            exit 1
        }
        $dossierFolder = $candidates[0].FullName
        Write-Host "-VerifyPost: using existing dossier folder $dossierFolder" -ForegroundColor DarkGray
    }

    # Resolve artifact paths
    $transcriptTxt = Join-Path $dossierFolder 'transcript.txt'
    $briefMd       = Join-Path $dossierFolder 'BRIEF.md'
    $verifyMd      = Join-Path $dossierFolder 'VERIFY.md'
    $manifestPath  = Join-Path $dossierFolder 'manifest.json'

    if (-not (Test-Path $transcriptTxt) -and -not (Test-Path $briefMd)) {
        Write-Error "No transcript.txt or BRIEF.md found in $dossierFolder. Cannot extract claims."
        exit 55
    }

    # V1 - Claims extraction
    Write-Host ""
    Write-Host "[verify 1/3] Extracting claims ..." -ForegroundColor Cyan
    $v1Result = Invoke-VerifyPostClaims -DossierFolder $dossierFolder -TranscriptTxt $transcriptTxt -BriefMd $briefMd
    if (-not $v1Result.ok) {
        Write-Error "Claims extraction failed (V1). Check $dossierFolder\claude-verify-v1.log"
        exit 56
    }
    $repoCount = if ($v1Result.claims.repos) { @($v1Result.claims.repos).Count } else { 0 }
    $libCount  = if ($v1Result.claims.libraries) { @($v1Result.claims.libraries).Count } else { 0 }
    $mcpCount  = if ($v1Result.claims.mcp_servers) { @($v1Result.claims.mcp_servers).Count } else { 0 }
    $modelCount = if ($v1Result.claims.models) { @($v1Result.claims.models).Count } else { 0 }
    Write-Host "  Claims found: repos=$repoCount, libs=$libCount, mcp=$mcpCount, models=$modelCount" -ForegroundColor DarkGray

    # V2 - Parallel verification
    Write-Host "[verify 2/3] Verifying claims ..." -ForegroundColor Cyan
    $v2Result = Invoke-VerifyPostCheck -Claims $v1Result.claims
    # NOTE: piping an empty array to ConvertTo-Json yields $null in PS7, not "[]".
    # Use -InputObject @() to force array context so V3 always sees a valid JSON array
    # even when V2 returned zero verifiable items.
    $verifyResultsJson = ConvertTo-Json -InputObject @($v2Result.results) -Depth 6
    Write-Host "  Verification complete: $($v2Result.results.Count) item(s) checked." -ForegroundColor DarkGray

    # V3 - Personalized synthesis
    Write-Host "[verify 3/3] Synthesizing VERIFY.md ..." -ForegroundColor Cyan
    $synthOk = Invoke-VerifyPostSynth `
        -DossierFolder $dossierFolder `
        -ClaimsJson $v1Result.claimsJson `
        -VerifyResultsJson $verifyResultsJson `
        -VerifyMd $verifyMd

    if ($synthOk) {
        # Write verify_path into manifest.json (idempotent rebuild)
        if (Test-Path $manifestPath) {
            try {
                $manifestObj = Get-Content -Path $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json
                $rebuild = [ordered]@{}
                foreach ($prop in $manifestObj.PSObject.Properties) { $rebuild[$prop.Name] = $prop.Value }
                $rebuild['verify_path'] = $verifyMd
                $rebuild | ConvertTo-Json -Depth 6 | Set-Content -Path $manifestPath -Encoding utf8
            } catch {
                Write-Warning "Could not write verify_path into manifest.json: $($_.Exception.Message)"
            }
        }

        Write-Host ""
        Write-Host "VERIFY complete." -ForegroundColor Green
        Write-Host "  VERIFY.md: $verifyMd" -ForegroundColor Green
        Write-Host "  Folder:    $dossierFolder" -ForegroundColor Green

        # Auto-open VERIFY.md unless -NoOpen
        if (-not $NoOpen) {
            try { Start-Process $verifyMd } catch {}
        }
    } else {
        Write-Warning "VERIFY.md synthesis did not produce output. See $dossierFolder\claude-verify-v3.log"
    }

    exit 0
}

# Mode 0d: -EchoTest <username> — write a hypothetical post in this creator's voice
if ($EchoTest) {
    $claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
    if (-not $claudeCmd) {
        Write-Error "claude CLI not on PATH. -EchoTest requires claude CLI."
        exit 1
    }
    if (-not (Test-Path $Script:VideoMemRoot)) {
        Write-Error "video-memory root not found at $Script:VideoMemRoot. Run at least one dossier first."
        exit 1
    }
    $cleanUser = $EchoTest -replace '^@',''
    $sigPath = Join-Path $Script:VideoMemRoot "ARCHIVE\SIGNATURES\$cleanUser.md"
    if (-not (Test-Path $sigPath)) {
        Write-Error "No signature found for @$cleanUser at $sigPath. Run -AnalyzeCreator $cleanUser first (requires 3+ dossiers)."
        exit 1
    }
    $echoPath = Join-Path $Script:VideoMemRoot "ARCHIVE\SIGNATURES\$cleanUser.echo.md"
    $echoLog  = Join-Path $Script:VideoMemRoot "ARCHIVE\SIGNATURES\$cleanUser.echo.log"

    $echoPrompt = @"
You have been given the creator signature for @$cleanUser, which describes their
consistent patterns, evolution trajectory, distinctive voice, and notable absences.
The signature file is at: $sigPath
Read it via your --add-dir access.

Your task: write ONE hypothetical NEW post in @$cleanUser's voice - the kind of
thing they would actually publish next. This is a self-validation exercise to test
whether the signature has enough texture to generate something specific and
recognizable in their voice.

Requirements:
- Match their tone, sentence rhythm, vocabulary, and any recurring structural
  moves described in the signature.
- Below the caption, write a 2-3 sentence "build brief" describing what the
  visuals or video would look like (stack, motion style, mood).
- If the signature described gaps or absences, do NOT fill them in - write
  around them, the way the actual creator would.
- Do NOT produce a generic creator post. If you cannot produce something that
  feels specific to @$cleanUser, say so explicitly and explain which signature
  sections lacked enough texture.

Write the output to $echoPath with this exact structure:

# Echo - @$cleanUser
_Hypothetical post generated from signature. Not for publishing._

## Simulated caption

[the caption here]

## Build brief

[the visual/technical brief here]

## Fidelity notes

[1-3 sentences: how confident are you this matches their voice? Which
 signature sections drove this? Which felt thin?]
"@

    Write-Host "Generating echo for @$cleanUser ..." -ForegroundColor DarkGray
    Write-Host "  Signature: $sigPath" -ForegroundColor DarkGray
    Write-Host "  Output:    $echoPath" -ForegroundColor DarkGray

    $stdout = $null
    try {
        $stdout = $echoPrompt | & claude --dangerously-skip-permissions --model claude-sonnet-4-6 -p --add-dir $Script:VideoMemRoot 2>&1
        Set-Content -Path $echoLog -Value ($stdout | Out-String) -Encoding utf8
    } catch {
        Write-Error "Echo test failed: $($_.Exception.Message)"
        exit 1
    }

    if ($LASTEXITCODE -ne 0) {
        Write-Error "claude CLI exited $LASTEXITCODE. See $echoLog"
        exit 1
    }

    # Primary path: claude wrote echo.md directly via its file-write capability
    if ((Test-Path $echoPath) -and ((Get-Item $echoPath).Length -gt 200)) {
        Write-Host "Echo written: $echoPath" -ForegroundColor Green
        exit 0
    }

    # Defensive stdout fallback: find the markdown header position and slice
    # the captured text from there forward, dropping any ANSI/stderr noise
    # that may have preceded it (since 2>&1 captures both streams).
    # The original regex (?m)^# Echo matched a header on ANY line, which
    # would save polluted streams. Codex Wave 4 review caught this.
    $stdoutText = if ($stdout -is [array]) { $stdout -join "`n" } else { [string]$stdout }
    $headerMatch = [regex]::Match($stdoutText, '(?m)^# Echo\s*-\s*@')
    if ($headerMatch.Success -and ($stdoutText.Length - $headerMatch.Index) -gt 200) {
        $markdownOnly = $stdoutText.Substring($headerMatch.Index)
        $markdownOnly | Set-Content -Path $echoPath -Encoding utf8
        if ((Test-Path $echoPath) -and ((Get-Item $echoPath).Length -gt 200)) {
            Write-Host "Echo written (from stdout fallback, sliced from markdown header): $echoPath" -ForegroundColor Green
            exit 0
        }
    }

    Write-Warning "Echo not produced. Check $echoLog for claude output."
    exit 1
}

# Mode 1: -InstallWatchTask
if ($InstallWatchTask) {
    Install-WatchTask -WatchInput $Watch -TimeStr $Time
    exit 0
}

# Mode 2: -Watch (no install)
if ($Watch) {
    if (-not (Test-ApifyTokenLooksValid -Token $env:APIFY_TOKEN)) { [void](Read-ApifyTokenInteractive) }
    if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
        Write-Error "ffmpeg not found on PATH. Install: winget install Gyan.FFmpeg"
        exit 3
    }
    if (-not (Test-Path $Script:VideoMemRoot)) { New-Item -ItemType Directory -Force -Path $Script:VideoMemRoot | Out-Null }
    $whisper = Get-WhisperBackend
    if ($whisper.Backend) { Write-Host "Whisper backend: $($whisper.Backend)" -ForegroundColor DarkGray }
    if ($whisper.Backend -eq 'whisper.cpp' -and -not $env:WHISPER_MODEL) {
        Write-Warning "whisper.cpp backend selected but `$env:WHISPER_MODEL is not set. Transcription will be skipped at runtime."
        Write-Host "  Set with: `$env:WHISPER_MODEL = 'C:\path\to\model.bin'" -ForegroundColor DarkGray
    }
    Invoke-WatchlistRun -WatchInput $Watch -Whisper $whisper `
        -DoTour:(-not $NoTour) -DoRecipe:(-not $NoRecipe) -ForceFlag:$Force `
        -DoNotebookLM:(-not $NoNotebookLM) -NotebookName $Notebook -AutoPodcast:$AutoPodcast `
        -NoArchive:$NoArchive -RebuildArchive:$RebuildArchive
    if ($OpenArchive) {
        $archIdx = Join-Path $Script:VideoMemRoot 'ARCHIVE\index.html'
        if (Test-Path $archIdx) {
            $browser = Get-DefaultBrowserExe
            if ($browser) {
                try { Start-Process -FilePath $browser -ArgumentList "`"$archIdx`"" } catch {}
            } else {
                try { Start-Process $archIdx } catch {}
            }
        }
    }
    exit 0
}

# Mode 3 + 4: $Url is required from here on
if (-not $Url) {
    Show-DossierHelp
    exit 0
}

# Token + ffmpeg checks
if (-not (Test-ApifyTokenLooksValid -Token $env:APIFY_TOKEN)) { [void](Read-ApifyTokenInteractive) }
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Error "ffmpeg not found on PATH. Install: winget install Gyan.FFmpeg"
    exit 3
}
if (-not (Test-Path $Script:VideoMemRoot)) { New-Item -ItemType Directory -Force -Path $Script:VideoMemRoot | Out-Null }

# Mode 3: batch (.txt file)
if ((Test-Path $Url) -and ($Url -match '\.txt$')) {
    $whisper = Get-WhisperBackend
    if ($whisper.Backend) { Write-Host "Whisper backend: $($whisper.Backend)" -ForegroundColor DarkGray }
    if ($whisper.Backend -eq 'whisper.cpp' -and -not $env:WHISPER_MODEL) {
        Write-Warning "whisper.cpp backend selected but `$env:WHISPER_MODEL is not set. Transcription will be skipped at runtime."
        Write-Host "  Set with: `$env:WHISPER_MODEL = 'C:\path\to\model.bin'" -ForegroundColor DarkGray
    }
    Invoke-BatchRun -ListFile $Url -Whisper $whisper `
        -DoTour:(-not $NoTour) -DoRecipe:(-not $NoRecipe) -ForceFlag:$Force -MaxJobs $MaxParallel `
        -DoNotebookLM:(-not $NoNotebookLM) -NotebookName $Notebook -AutoPodcast:$AutoPodcast `
        -NoArchive:$NoArchive -RebuildArchive:$RebuildArchive
    if ($OpenArchive) {
        $archIdx = Join-Path $Script:VideoMemRoot 'ARCHIVE\index.html'
        if (Test-Path $archIdx) {
            $browser = Get-DefaultBrowserExe
            if ($browser) {
                try { Start-Process -FilePath $browser -ArgumentList "`"$archIdx`"" } catch {}
            } else {
                try { Start-Process $archIdx } catch {}
            }
        }
    }
    exit 0
}

# Mode 4: single URL
$whisper = Get-WhisperBackend
if ($whisper.Backend) {
    Write-Host "Whisper backend detected: $($whisper.Backend)" -ForegroundColor DarkGray
    if ($whisper.Backend -eq 'whisper.cpp' -and -not $env:WHISPER_MODEL) {
        Write-Warning "whisper.cpp backend selected but `$env:WHISPER_MODEL is not set. Transcription will be skipped at runtime."
        Write-Host "  Set with: `$env:WHISPER_MODEL = 'C:\path\to\model.bin'" -ForegroundColor DarkGray
    }
} else {
    Write-Host "Whisper not installed - transcription will be skipped." -ForegroundColor DarkGray
    Write-Host "  Install one of: pip install faster-whisper / pip install openai-whisper / whisper.cpp" -ForegroundColor DarkGray
}

$result = Invoke-DossierForUrl -Url $Url -Whisper $whisper `
    -DoTour:(-not $NoTour) -DoRecipe:(-not $NoRecipe) -DoOpen:(-not $NoOpen) -ForceFlag:$Force `
    -DoNotebookLM:(-not $NoNotebookLM) -NotebookName $Notebook -AutoPodcast:$AutoPodcast `
    -NoArchive:$NoArchive -RebuildArchive:$RebuildArchive

if ($OpenArchive) {
    $archIdx = Join-Path $Script:VideoMemRoot 'ARCHIVE\index.html'
    if (Test-Path $archIdx) {
        $browser = Get-DefaultBrowserExe
        if ($browser) {
            try { Start-Process -FilePath $browser -ArgumentList "`"$archIdx`"" } catch {}
        } else {
            try { Start-Process $archIdx } catch {}
        }
    }
}

switch ($result.status) {
    'failed' {
        Write-Error "DOSSIER failed: $($result.reason)"
        exit 1
    }
    'cached' {
        Write-Host ""
        Write-Host "DOSSIER (cached, not re-run)." -ForegroundColor Green
        Write-Host "  Folder: $($result.folder)" -ForegroundColor Green
        exit 0
    }
    'succeeded' {
        $r = $result.result
        Write-Host ""
        Write-Host "DOSSIER complete." -ForegroundColor Green
        Write-Host "  Platform:    $($r.platform)" -ForegroundColor Green
        Write-Host "  Folder:      $($r.outDir)" -ForegroundColor Green
        Write-Host "  Frames:      $($r.frameCount)" -ForegroundColor Green
        Write-Host "  Audio:       $(if ($r.audioOk) { 'yes' } else { 'no' })" -ForegroundColor Green
        Write-Host "  Transcript:  $(if ($r.transcriptOk) { 'yes' } else { 'no - ' + $r.transcriptionReason })" -ForegroundColor Green
        Write-Host "  Profile:     $(if ($r.profileOk) { 'yes' } else { 'no - ' + $r.profileError })" -ForegroundColor Green
        Write-Host "  Tour:        $(if ($r.tourRan) { 'yes' } else { 'no/skipped' })" -ForegroundColor Green
        Write-Host "  Recipe:      $(if ($r.recipeRan) { 'yes' } else { 'no/skipped' })" -ForegroundColor Green
        Write-Host "  NotebookLM:  $(if ($r.notebookOk) { $r.notebookUrl } else { 'no/skipped' })" -ForegroundColor Green
        if ($r.notebookPodcastId) {
            Write-Host "  Podcast:     $($r.notebookPodcastId) (Audio Overview generation queued)" -ForegroundColor Green
        }
        Write-Host "  BRIEF.md:    $($r.briefMd)" -ForegroundColor Green
        Write-Host "  index.html:  $($r.htmlPath)" -ForegroundColor Green
        exit 0
    }
}
