#!/bin/bash

# Function to display help
show_help() {
  cat << EOF
Plex Library Refresh Script

DESCRIPTION:
    Refreshes Plex library sections. Can refresh all sections or specific ones.

USAGE:
    $0 [OPTIONS] [SECTION_IDS...]

OPTIONS:
    -h, --help       Show this help message and exit
    --wait-finish    Wait for all library scans to complete before exiting
    -v, --verbose    Enable verbose debug output

ARGUMENTS:
    SECTION_IDS   Optional comma-separated list of section IDs to refresh.
                  If not provided, all sections will be refreshed.

EXAMPLES:
    $0                           # Refresh all library sections
    $0 1,3,5                    # Refresh sections 1, 3, and 5
    $0 --wait-finish            # Refresh all sections and wait for completion
    $0 --wait-finish 1,3,5      # Refresh specific sections and wait for completion
    $0 -v --wait-finish 1,3,5   # Verbose mode with wait for completion
    $0 --help                   # Show this help message

REQUIREMENTS:
    - .env file in current directory with:
      PLEX_TOKEN=your_plex_token
      PLEX_HOST=http://your_plex_server:port
      POLL_INTERVAL=2 (optional, defaults to 0 seconds)

EOF
}

# Initialize variables
WAIT_FOR_FINISH=false
VERBOSE=false

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    -h|--help)
      show_help
      exit 0
      ;;
    --wait-finish)
      WAIT_FOR_FINISH=true
      shift
      ;;
    -v|--verbose)
      VERBOSE=true
      shift
      ;;
    *)
      # Remaining arguments are section IDs
      break
      ;;
  esac
done

# Debug logging function
debug_log() {
  if [ "$VERBOSE" = true ]; then
    echo "[DEBUG] $1"
  fi
}

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

debug_log "Script directory: $SCRIPT_DIR"

# Check if .env file exists in the script directory
if [ ! -f "$SCRIPT_DIR/.env" ]; then
  echo "Error: .env file not found in script directory: $SCRIPT_DIR"
  echo "Please create a .env file with PLEX_TOKEN and PLEX_HOST variables"
  exit 1
fi

debug_log "Found .env file in script directory, loading environment variables"

# Load environment variables from .env file in script directory
export $(grep -v '^#' "$SCRIPT_DIR/.env" | xargs)

debug_log "Environment variables loaded from .env file"

# Check if required variables are set
if [ -z "$PLEX_TOKEN" ]; then
  echo "Error: PLEX_TOKEN is not set in .env file"
  exit 1
fi

if [ -z "$PLEX_HOST" ]; then
  echo "Error: PLEX_HOST is not set in .env file"
  exit 1
fi

# Set poll interval (default to 0 if not specified)
POLL_INTERVAL=${POLL_INTERVAL:-0}

debug_log "Required environment variables validated"
debug_log "Poll interval set to: ${POLL_INTERVAL} seconds"
echo "Using Plex host: $PLEX_HOST"

# Check if section IDs were provided as arguments
if [ $# -gt 0 ]; then
  # Use provided section IDs (convert comma-separated to space-separated)
  section_ids=$(echo "$*" | tr ',' ' ')
  echo "Using provided section IDs: $*"
  debug_log "Converted section IDs to space-separated: $section_ids"
else
  # Get all section keys (IDs) from API
  echo "No section IDs provided, fetching all sections from API..."
  debug_log "Making API call to: $PLEX_HOST/library/sections"
  
  sections_response=$(curl -s "$PLEX_HOST/library/sections?X-Plex-Token=$PLEX_TOKEN")
  debug_log "Sections API response received (length: ${#sections_response})"
  
  section_ids=$(echo "$sections_response" | grep -oP 'key="\K[0-9]+(?=")' | sort -u)
  
  if [ -z "$section_ids" ]; then
    echo "Error: Could not retrieve section IDs from Plex API"
    debug_log "Raw API response: $sections_response"
    exit 1
  fi
  
  echo "Found sections: $(echo $section_ids | tr ' ' '\n' | sort -n | tr '\n' ',' | sed 's/,$//')"
  debug_log "Extracted section IDs: $section_ids"
fi

# Track which sections we started scanning
declare -A started_sections
declare -A completed_sections

debug_log "Initialized tracking arrays for sections"

# Refresh each section
for id in $(echo $section_ids | tr ' ' '\n' | sort -n); do
  echo "Refreshing section $id..."
  debug_log "Making refresh API call for section $id"
  debug_log "API URL: $PLEX_HOST/library/sections/$id/refresh"
  
  response=$(curl -s -w "%{http_code}" "$PLEX_HOST/library/sections/$id/refresh?X-Plex-Token=$PLEX_TOKEN")
  http_code="${response: -3}"
  
  debug_log "Section $id refresh response - HTTP code: $http_code"
  
  if [ "$http_code" = "200" ]; then
    echo "  ✓ Section $id refresh initiated successfully"
    started_sections[$id]=1
    debug_log "Marked section $id as started in tracking array"
  else
    echo "  ✗ Failed to refresh section $id (HTTP $http_code)"
    debug_log "Section $id failed - not adding to started_sections array"
  fi
done

# Wait for scans to complete if --wait-finish flag was provided
if [ "$WAIT_FOR_FINISH" = true ]; then
  echo ""
  echo "Waiting for all library scans to complete..."
  debug_log "Wait-finish mode enabled - starting activity monitoring"
  debug_log "Started sections: ${!started_sections[*]}"
  debug_log "Using poll interval: ${POLL_INTERVAL} seconds"
  
  # Initialize progress tracking for clean output
  declare -A section_status
  declare -A section_progress  
  declare -A section_subtitle
  progress_displayed=false
  
  # Initialize all started sections with pending status
  for id in "${!started_sections[@]}"; do
    section_status[$id]="pending"
    section_progress[$id]=""
    section_subtitle[$id]=""
  done
  
  # Function to display progress table
  display_progress() {
    # Clear previous output if it was displayed before
    if [ "$progress_displayed" = true ]; then
      # Count actual lines that will be displayed
      local line_count=$(echo "${!started_sections[@]}" | tr ' ' '\n' | sort -n | wc -l)
      # Move cursor up by the number of lines and clear them
      for ((i=0; i<line_count; i++)); do
        echo -ne "\033[1A\033[2K"
      done
    fi
    
    # Display current status for all sections in consistent order
    for id in $(echo "${!started_sections[@]}" | tr ' ' '\n' | sort -n); do
      case "${section_status[$id]}" in
        "scanning")
          echo "  Section $id: ${section_progress[$id]}% complete $([ -n "${section_subtitle[$id]}" ] && echo "(${section_subtitle[$id]})")"
          ;;
        "completed")
          echo "  Section $id: ✓ Completed"
          ;;
        "pending")
          echo "  Section $id: Pending..."
          ;;
      esac
    done
    
    progress_displayed=true
  }
  
  # Function to check activities and track progress
  check_activities() {
    debug_log "Checking activities API..."
    local activities_xml=$(curl -s "$PLEX_HOST/activities?X-Plex-Token=$PLEX_TOKEN")
    debug_log "Activities API response received (length: ${#activities_xml})"
    
    local scanning_sections=$(echo "$activities_xml" | grep -oP 'librarySectionID="\K[0-9]+(?=")' | sort -u)
    debug_log "Currently scanning sections: $scanning_sections"
    
    # Update status for actively scanning sections
    if [ -n "$scanning_sections" ]; then
      debug_log "Found active scanning sections"
      for scanning_id in $scanning_sections; do
        if [[ -n "${started_sections[$scanning_id]}" ]]; then
          debug_log "Section $scanning_id is one of our tracked sections"
          # Find the Activity line that corresponds to this section
          local activity_line=$(echo "$activities_xml" | grep -A1 "library.update.section" | grep -B1 "librarySectionID=\"$scanning_id\"" | grep "library.update.section")
          local progress=$(echo "$activity_line" | grep -oP 'progress="\K[0-9]+(?=")')
          local subtitle=$(echo "$activity_line" | grep -oP 'subtitle="\K[^"]*(?=")')
          
          section_status[$scanning_id]="scanning"
          section_progress[$scanning_id]="$progress"
          section_subtitle[$scanning_id]="$subtitle"
          
          debug_log "Section $scanning_id progress: ${progress}%, subtitle: '$subtitle'"
        else
          debug_log "Section $scanning_id is scanning but not in our tracked list"
        fi
      done
    else
      debug_log "No active scanning sections found"
    fi
    
    # Check if any started sections are not currently scanning and mark them as completed
    for id in "${!started_sections[@]}"; do
      if [[ "${section_status[$id]}" != "completed" ]]; then
        debug_log "Checking if section $id should be marked as completed"
        # Section was started but not yet marked as completed
        if [[ -z "$scanning_sections" ]] || [[ ! " $scanning_sections " =~ " $id " ]]; then
          # Section is not currently in the scanning list, mark as completed
          section_status[$id]="completed"
          debug_log "Marked section $id as completed"
        else
          debug_log "Section $id still scanning, not marking as completed yet"
        fi
      else
        debug_log "Section $id already marked as completed"
      fi
    done
    
    # Display updated progress
    display_progress
    
    # Check if all started sections are completed
    local incomplete_count=0
    for id in "${!started_sections[@]}"; do
      if [[ "${section_status[$id]}" != "completed" ]]; then
        incomplete_count=$((incomplete_count + 1))
        debug_log "Section $id still incomplete (status: ${section_status[$id]})"
      fi
    done
    
    debug_log "Incomplete sections count: $incomplete_count"
    
    if [ $incomplete_count -eq 0 ]; then
      debug_log "All sections completed, returning success"
      return 0  # All sections completed
    else
      debug_log "Still have incomplete sections, continuing to poll"
      return 1  # Still have incomplete sections
    fi
  }
  
  # Poll until all scans complete
  while true; do
    if check_activities; then
      echo "  ✓ All library scans completed!"
      debug_log "All scans completed, exiting monitoring loop"
      break
    fi
    if [ "$POLL_INTERVAL" -gt 0 ]; then
      debug_log "Sleeping for ${POLL_INTERVAL} seconds before next check"
      sleep "$POLL_INTERVAL"
    fi
  done
fi

echo "Refresh operation completed."
debug_log "Script execution finished"