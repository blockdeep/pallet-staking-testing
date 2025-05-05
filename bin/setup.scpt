#!/usr/bin/osascript

set scriptPath to (do shell script "dirname " & quoted form of (POSIX path of (path to me)))

tell application "iTerm2"
  create window with default profile
  tell current window
    -- Get the screen resolution for maximum size
    set screenSize to do shell script "system_profiler SPDisplaysDataType | awk '/Resolution:/ {print $2, $4}' | head -n 1"
    set screenWidth to word 1 of screenSize as integer
    set screenHeight to word 2 of screenSize as integer
    -- Set the window bounds to maximize it
    set bounds to {0, 0, screenWidth/ 2, screenHeight/ 2}
  end tell

  tell current session of current window
    -- Split pane vertically
    set session2 to split vertically with default profile
    -- Split left pane horizontally
    set session3 to split horizontally with default profile
  end tell

  -- Send commands to each pane
  tell current session of current window
    write text "cd " & quoted form of scriptPath & "/../../polkadot-sdk/substrate/frame/staking-async/runtimes/parachain && ./build-and-run-zn.sh"
  end tell

  tell session2
    write text "cd /tmp"
    write text "npx @acala-network/chopsticks@latest -e ws://127.0.0.1:9966" without newline
  end tell

  tell session3
    write text "sleep 90 && RUST_LOG=\"polkadot-staking-miner=trace,info\" polkadot-staking-miner --uri ws://127.0.0.1:9966 experimental-monitor-multi-block --seed-or-path //Bob"
  end tell
end tell
