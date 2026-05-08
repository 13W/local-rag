#!/bin/bash

curl "https://generativelanguage.googleapis.com/v1/models?key=$GEMINI_API_KEY" | jq '.models[] |  .name'
curl "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY" | jq '.models[] |  .name'

sleep 2

export MEMORY_DEBUG_LOG=/tmp/local-rag-debug.log
truncate -s 0 ${MEMORY_DEBUG_LOG}

pnpm start
