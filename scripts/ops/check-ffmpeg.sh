#!/usr/bin/env bash
# Verify an FFmpeg build has everything the KSP worker / ai-worker need. Run at image build time (Dockerfile),
# in CI, and after replacing the ffmpeg binary on a host.
#   scripts/ops/check-ffmpeg.sh [/path/to/ffmpeg]
set -euo pipefail
FF="${1:-${FFMPEG_PATH:-ffmpeg}}"
FP="${FFPROBE_PATH:-$(dirname "$(command -v "$FF" 2>/dev/null || echo "$FF")")/ffprobe}"
command -v "$FF" >/dev/null 2>&1 || [ -x "$FF" ] || { echo "ffmpeg not found: $FF" >&2; exit 1; }
missing=()
filters=$("$FF" -hide_banner -filters 2>/dev/null)
encoders=$("$FF" -hide_banner -encoders 2>/dev/null)
decoders=$("$FF" -hide_banner -decoders 2>/dev/null)
demuxers=$("$FF" -hide_banner -demuxers 2>/dev/null)
has() { grep -qE "$2" <<<"$1" || missing+=("$3"); }
# Watermark burn-in for shared media uses the subtitles/ass filters (libass).
has "$filters" '^ ... (subtitles|ass) ' "filter subtitles/ass (libass) — watermark burn-in"
has "$filters" '^ ... scale ' "filter scale"
# Proxy / HLS encoding.
has "$encoders" ' libx264 ' "encoder libx264 (H.264 proxies/HLS)"
has "$encoders" ' aac ' "encoder aac"
has "$encoders" ' mjpeg ' "encoder mjpeg (thumbnails/snapshots/AI frames)"
has "$encoders" ' png ' "encoder png (exact-frame snapshots)"
# Body-worn camera inputs.
for d in h264 hevc mjpeg mpeg4 aac pcm_s16le; do has "$decoders" " $d " "decoder $d"; done
for d in mov mp4 matroska avi mpegts; do has "$demuxers" "[ ,]${d}[ ,]" "demuxer $d"; done
[ -x "$FP" ] || command -v "$FP" >/dev/null 2>&1 || missing+=("ffprobe next to ffmpeg ($FP)")
# Not `| head -1`: with pipefail, head closing the pipe early kills ffmpeg with SIGPIPE (exit 141) — this failed
# the first real worker image build.
version=$("$FF" -hide_banner -version)
echo "${version%%$'\n'*}"
if [ ${#missing[@]} -gt 0 ]; then
  printf 'MISSING: %s\n' "${missing[@]}" >&2
  exit 1
fi
echo "ffmpeg capability check OK"
