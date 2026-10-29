#!/bin/zsh
# Records the intro video: runs the WalkthroughTests UI test on the Simulator while recording the screen,
# then lays a Chinese voiceover (macOS `say`, voice Tingting) and soft subtitles on each scene.
# Usage (from packages/ios): tools/record-walkthrough.sh <simulator-id> <out.mp4> [light|dark]
set -euo pipefail
ID=$1 OUT=$2 MODE=${3:-light}
WORK=$(mktemp -d)
NARRATION=(
  "这是 Juno 的 iPhone 原型。打开就是和 agent 的对话，顶部是它的名字和正在做的事。"
  "消息流和网页版一一对应：提问、登录请求、routine、交接提示，还有正在运行的任务。"
  "点运行这一行，可以展开每一步；再点某一步，看它的输入和输出。"
  "右上角打开工作区。这里能看到 agent 的电脑，需要你的时候会出现横幅，你也可以随时接管。"
  "点标题可以切换到等你处理、进度、文件，和这个 agent 在所有对话里的情况。"
  "返回就是全部对话，最上面一行是等你处理。"
  "等你处理一条一条看，可以直接允许或者拒绝。"
  "审批卡和网页版一样：允许、拒绝，详情里有具体字段、原因和草稿。"
  "点标题打开 agent 卡片，可以改资料、看它记住的东西和权限。"
  "Ideas 是 agent 主动给的建议。点一下就回到对话，输入框已经填好，直接发送。"
  "Goals 汇总了每个 agent 在跟踪的事和长期目标，下面是今天稍后要跑的 routine。"
  "文件可以按 agent 筛选。更多里是所有 agent 和 Routines、规则、记忆这些全局页面。"
  "以上就是目前的原型，用的全部是模拟数据。"
)
for i in {1..${#NARRATION}}; do say -v Tingting -r 210 -o $WORK/s$i.aiff "${NARRATION[$i]}"; done

xcrun simctl ui $ID appearance $MODE
xcrun simctl io $ID recordVideo --codec=h264 --force $WORK/screen.mp4 &
REC=$!
sleep 2
START=$(python3 -c 'import time; print(time.time())')
xcodebuild test -project Juno.xcodeproj -scheme Juno -destination "id=$ID" -derivedDataPath build \
  -only-testing:JunoUITests/WalkthroughTests/testWalkthrough > $WORK/test.log 2>&1 || true
sleep 1
kill -INT $REC; wait $REC || true

# Scene offsets relative to the recording start → voiceover delays + an SRT track.
grep -o 'SCENE|[0-9]*|[0-9.]*' $WORK/test.log | sort -u -t'|' -k2,2n > $WORK/scenes.txt
python3 - "$WORK" "$START" "${NARRATION[@]}" <<'PY'
import subprocess, sys
work, start, lines = sys.argv[1], float(sys.argv[2]), sys.argv[3:]
scenes = [l.strip().split('|') for l in open(f"{work}/scenes.txt") if l.strip()]
inputs, filters, srt = ["-i", f"{work}/screen.mp4"], [], []
def ts(t): return f"{int(t//3600):02}:{int(t%3600//60):02}:{int(t%60):02},{int(t*1000%1000):03}"
for k, (_, n, epoch) in enumerate(scenes):
    n, off = int(n), max(float(epoch) - start, 0) + 0.3
    inputs += ["-i", f"{work}/s{n}.aiff"]
    filters.append(f"[{k+1}:a]adelay={int(off*1000)}|{int(off*1000)}[a{k}]")
    dur = float(subprocess.check_output(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",f"{work}/s{n}.aiff"]))
    srt.append(f"{k+1}\n{ts(off)} --> {ts(off+dur)}\n{lines[n-1]}\n")
open(f"{work}/subs.srt","w").write("\n".join(srt))
mix = "".join(f"[a{k}]" for k in range(len(scenes))) + f"amix=inputs={len(scenes)}:normalize=0[aout]"
cmd = ["ffmpeg","-y","-v","error",*inputs,"-i",f"{work}/subs.srt","-filter_complex",";".join(filters+[mix]),
       "-map","0:v","-map","[aout]","-map",f"{len(scenes)+1}:s","-c:v","copy","-c:a","aac","-c:s","mov_text",
       "-metadata:s:s:0","language=chi","-shortest", f"{work}/out.mp4"]
subprocess.check_call(cmd)
# Trim the build/launch time before the first scene and shrink to 2/3 size.
first = max(float(scenes[0][2]) - start - 1.5, 0)
subprocess.check_call(["ffmpeg","-y","-v","error","-ss",f"{first:.2f}","-i",f"{work}/out.mp4","-map","0",
    "-c:v","libx264","-crf","24","-preset","medium","-vf","scale=804:-2","-pix_fmt","yuv420p",
    "-c:a","aac","-c:s","mov_text","-movflags","+faststart",f"{work}/final.mp4"])
PY
mv $WORK/final.mp4 "$OUT"
grep -E 'MISSING|TEST (SUCCEEDED|FAILED)' $WORK/test.log || true
echo "wrote $OUT"
