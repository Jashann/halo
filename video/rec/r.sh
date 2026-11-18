#!/bin/sh
# send one JSON command to the recording harness
curl -s --max-time 600 127.0.0.1:8899 -d "$1"; echo
