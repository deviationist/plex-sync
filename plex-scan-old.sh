#!/bin/bash

PLEX_TOKEN="xkdP9uszpHD7wVNbm1Rf"
PLEX_HOST="http://localhost:32400"

# Get section keys (IDs)
section_ids=$(curl -s "$PLEX_HOST/library/sections?X-Plex-Token=$PLEX_TOKEN" \
  | grep -oP 'key="\K[0-9]+(?=")' | sort -u)

for id in $section_ids; do
  #echo "Refreshing section $id..."
  curl -s "$PLEX_HOST/library/sections/$id/refresh?X-Plex-Token=$PLEX_TOKEN"
done

