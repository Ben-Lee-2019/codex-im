#!/usr/bin/env bash
set -euo pipefail

USER_NAME="${1:-${USER:-$(id -un)}}"
CACHE_DIR="${CODEX_IM_SLURM_CACHE_DIR:-/tmp/codex-im-slurm-cache}"
INTERVAL_SECONDS="${CODEX_IM_SLURM_CACHE_INTERVAL_SECONDS:-2}"
mkdir -p "$CACHE_DIR"

while true; do
  tmpdir="$(mktemp -d "${CACHE_DIR}/.${USER_NAME}.XXXXXX")"
  squeue_file="${tmpdir}/squeue.txt"
  squeue -h -u "$USER_NAME" -o $'%i\t%t\t%j\t%M\t%R' >"$squeue_file" 2>/dev/null || : 

  while IFS=$'\t' read -r jobid state _rest; do
    [[ -n "${jobid}" ]] || continue
    if [[ "${state}" == "R" ]]; then
      timeout 4 scontrol show job -dd "$jobid" >"${tmpdir}/detail-${jobid}.txt" 2>/dev/null || :
      timeout 8 srun --jobid "$jobid" --overlap --ntasks=1 \
        nvidia-smi --query-gpu=index,name,power.draw,power.limit,utilization.gpu,memory.used,memory.total \
        --format=csv,noheader,nounits >"${tmpdir}/gpu-${jobid}.txt" 2>/dev/null || :
    fi
  done <"$squeue_file"

  python - "$tmpdir" "${CACHE_DIR}/${USER_NAME}.json" "$USER_NAME" <<'PY'
import datetime
import json
import pathlib
import sys

tmpdir = pathlib.Path(sys.argv[1])
cache_path = pathlib.Path(sys.argv[2])
user_name = sys.argv[3]

payload = {
    "collectedAt": datetime.datetime.utcnow().isoformat() + "Z",
    "userName": user_name,
    "squeueStdout": (tmpdir / "squeue.txt").read_text(encoding="utf-8", errors="replace")
        if (tmpdir / "squeue.txt").exists()
        else "",
    "jobDetails": {},
    "gpuSnapshots": {},
}

for detail_file in tmpdir.glob("detail-*.txt"):
    job_id = detail_file.stem.replace("detail-", "", 1)
    payload["jobDetails"][job_id] = detail_file.read_text(encoding="utf-8", errors="replace")

for gpu_file in tmpdir.glob("gpu-*.txt"):
    job_id = gpu_file.stem.replace("gpu-", "", 1)
    payload["gpuSnapshots"][job_id] = gpu_file.read_text(encoding="utf-8", errors="replace")

cache_path.write_text(json.dumps(payload), encoding="utf-8")
PY

  rm -rf "$tmpdir"
  sleep "$INTERVAL_SECONDS"
done
