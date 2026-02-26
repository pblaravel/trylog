#!/bin/bash

SUPABASE_URL="https://vazeilznifsjxquigwpc.supabase.co"
ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZhemVpbHpuaWZzanhxdWlnd3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTQ0OTM1NTMsImV4cCI6MjA3MDA2OTU1M30.cU9rOWQheXkBs7BITd3eHlfmdIdOqmDD3uDVD3oWeQ8"

if [ -z "$1" ] || [ -z "$2" ]; then
    echo "Usage: ./get-token.sh your@email.com your-password"
    exit 1
fi

EMAIL="$1"
PASSWORD="$2"

echo "🔐 Getting JWT token..."

RESPONSE=$(curl -s -X POST "$SUPABASE_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")

# Check if jq is available
if ! command -v jq &> /dev/null; then
    echo "⚠️  jq not found, showing raw response:"
    echo "$RESPONSE"
    exit 1
fi

# Check for error
ERROR=$(echo "$RESPONSE" | jq -r '.error // empty')
if [ ! -z "$ERROR" ]; then
    echo "❌ Error: $ERROR"
    MESSAGE=$(echo "$RESPONSE" | jq -r '.error_description // .message // "Unknown error"')
    echo "   $MESSAGE"
    exit 1
fi

# Extract JWT token
JWT=$(echo "$RESPONSE" | jq -r '.access_token')

if [ -z "$JWT" ] || [ "$JWT" = "null" ]; then
    echo "❌ Failed to get JWT token"
    echo "$RESPONSE"
    exit 1
fi

echo ""
echo "✅ Success!"
echo ""
echo "📋 JWT Token:"
echo "$JWT"
echo ""
echo "🧪 Now run test:"
echo "curl -X POST https://vazeilznifsjxquigwpc.supabase.co/functions/v1/save-task \\"
echo "  -H \"Authorization: Bearer $JWT\" \\"
echo "  -H \"Content-Type: application/json\" \\"
echo "  -H \"apikey: $ANON_KEY\" \\"
echo "  -d '{\"title\":\"Test\",\"tags\":[\"API\"],\"location\":{\"city\":\"Vancouver\",\"state\":\"BC\"}}'"
echo ""

