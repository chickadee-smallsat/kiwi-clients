Set-Location "$PSScriptRoot\kiwi-3d"
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Set-Location "$PSScriptRoot\plotly-client"
cargo run
