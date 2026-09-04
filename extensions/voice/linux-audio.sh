#!/usr/bin/env bash
# Linux microphone helper for pi-meta-oauth voice.
# Captures 16 kHz mono signed 16-bit little-endian PCM through PulseAudio or
# ALSA and emits the same line-delimited JSON protocol as the native helpers.

set -u

FRAME_BYTES=3200
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi-meta-voice.XXXXXX")" || exit 1
fifo="$work_dir/audio"
stderr_file="$work_dir/capture.stderr"
frame_file="$work_dir/frame"
stop_file="$work_dir/stop"
capture_pid=""
control_pid=""

json_error() {
	local message
	message="$(printf '%s' "$1" | tr '\r\n' '  ' | sed 's/\\/\\\\/g; s/"/\\"/g')"
	printf '{"type":"error","message":"%s"}\n' "$message"
}

cleanup() {
	if [[ -n "$control_pid" ]]; then
		kill "$control_pid" 2>/dev/null || true
	fi
	if [[ -n "$capture_pid" ]]; then
		kill "$capture_pid" 2>/dev/null || true
	fi
	rm -rf "$work_dir"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

if command -v parec >/dev/null 2>&1; then
	capture=(parec --raw --format=s16le --rate=16000 --channels=1)
elif command -v arecord >/dev/null 2>&1; then
	capture=(arecord -q -t raw -f S16_LE -r 16000 -c 1)
else
	json_error "No Linux microphone recorder was found. Install pulseaudio-utils (parec) or alsa-utils (arecord)."
	exit 2
fi

if ! mkfifo "$fifo"; then
	json_error "Could not initialize the Linux microphone audio pipe."
	exit 3
fi

# Preserve the controller input explicitly; non-interactive shells otherwise
# attach /dev/null to a background command's stdin.
exec 4<&0
"${capture[@]}" >"$fifo" 2>"$stderr_file" &
capture_pid=$!
# Keep one read descriptor open for the lifetime of capture so the recorder
# never sees a transient broken pipe between frame reads.
exec 3<"$fifo"
printf '{"type":"ready","sampleRate":16000,"channels":1,"encoding":"pcm_s16le"}\n'

# The controller writes "stop" on stdin. EOF also stops capture, matching the
# macOS and Windows helpers when their parent process closes stdin.
(
	while IFS= read -r command; do
		if [[ "${command//[[:space:]]/}" == "stop" ]]; then
			break
		fi
	done
	: >"$stop_file"
	kill "$capture_pid" 2>/dev/null || true
) <&4 &
control_pid=$!

while :; do
	: >"$frame_file"
	dd of="$frame_file" bs=$FRAME_BYTES count=1 iflag=fullblock status=none <&3 2>/dev/null
	bytes=$(wc -c <"$frame_file")
	if (( bytes == 0 )); then
		break
	fi
	# Pad a final short read so every emitted audio payload is one 100 ms frame.
	if (( bytes < FRAME_BYTES )); then
		truncate -s $FRAME_BYTES "$frame_file"
	fi
	printf '{"type":"audio","data":"'
	base64 <"$frame_file" | tr -d '\r\n'
	printf '"}\n'
done

wait "$capture_pid" 2>/dev/null
capture_status=$?
capture_pid=""
kill "$control_pid" 2>/dev/null || true
wait "$control_pid" 2>/dev/null || true
control_pid=""

if [[ -f "$stop_file" ]]; then
	printf '{"type":"stopped"}\n'
	exit 0
fi

capture_error="$(cat "$stderr_file" 2>/dev/null)"
if [[ -z "$capture_error" ]]; then
	capture_error="Linux microphone capture exited unexpectedly with code $capture_status. Check PULSE_SERVER and the default input source."
fi
json_error "$capture_error"
if (( capture_status == 0 )); then
	capture_status=4
fi
exit "$capture_status"
