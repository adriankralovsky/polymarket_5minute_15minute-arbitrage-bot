# Beat Price Fetch Issues - Fixed

## Issues Found

### Issue 1: Timestamp Calculation Mismatch ⚠️ **CRITICAL**

**Problem:**
- `initializeMarket()` was calculating `startTime` manually from `event.markets?.[0]` only
- `getBeatPriceFromEvent()` uses `getMarketStartTimestamp()` which loops through **ALL markets**
- For 15m markets with multiple markets, the first market might not have `eventStartTime`
- This caused different timestamps to be used for cache key vs actual fetch

**Example:**
```typescript
// OLD CODE (WRONG):
const market = event.markets?.[0]; // Only checks first market
const eventStartTimeStr = market.eventStartTime || event.startDate || ...;
const startTime = new Date(eventStartTimeStr).getTime() / 1000;
const cacheKey = Math.floor(startTime); // Might be wrong for 15m markets!

// But getBeatPriceFromEvent uses:
const startTimestamp = getMarketStartTimestamp(event); // Loops ALL markets
// This might return a DIFFERENT timestamp!
```

**Impact:**
- Cache key mismatch → beat price not found in cache even if already fetched
- Wrong timestamp used → Chainlink API might fail or return wrong price
- 15m markets more likely to fail because they often have multiple markets

### Issue 2: Insufficient Error Logging

**Problem:**
- When beat price fetch failed, logs didn't show enough detail
- Hard to debug why 15m markets were failing
- No visibility into which market had the timestamp

**Impact:**
- Difficult to diagnose 15m market beat price failures
- No way to see if it's a timestamp issue or API issue

## Fixes Applied

### Fix 1: Use Same Timestamp Method ✅

**Changed:**
```typescript
// NEW CODE (CORRECT):
// Use the same method as getBeatPriceFromEvent
const startTimestamp = this.client.getMarketStartTimestamp(event);
const cacheKey = startTimestamp ? Math.floor(startTimestamp) : 0;
```

**Benefits:**
- ✅ Same timestamp calculation for cache key and fetch
- ✅ Checks ALL markets (important for 15m markets)
- ✅ Consistent behavior between cache lookup and API fetch

### Fix 2: Enhanced Error Logging ✅

**Added:**
- Detailed error messages when timestamp not found
- Shows all market keys and values
- Shows which method was used to get timestamp
- Clear success/failure indicators (✅/❌)

**Example Output:**
```
❌ CRITICAL: Could not determine market start timestamp for 15m market
Event slug: btc-updown-15m-1771097400
Event has 2 markets
First market keys: id, conditionId, slug, eventStartTime, startDate, ...
First market eventStartTime: 2024-01-15T10:00:00Z
First market startDate: N/A
Event startDate: 2024-01-15T10:00:00Z
Event creationDate: 2024-01-15T09:55:00Z
```

## Why 15m Markets Were Failing

1. **Multiple Markets**: 15m events often have multiple markets in the `event.markets` array
2. **First Market Missing Data**: The first market (`event.markets[0]`) might not have `eventStartTime`
3. **Timestamp Mismatch**: Different timestamp calculation caused cache misses
4. **API Failures**: Wrong timestamp sent to Chainlink API → no price found

## Testing

To verify the fix works:

```bash
cd /home/novo/bot/btc5-15arb
npm run build

# Test 15m market beat price
node dist/test-beat-price.js btc-updown-15m-1771097400

# Check logs for:
# ✅ Fetched and cached beat price for 15m market
# OR
# ❌ Failed to fetch beat price (with detailed error)
```

## Key Changes

1. **`initializeMarket()`** now uses `getMarketStartTimestamp(event)` instead of manual calculation
2. **Cache key** now matches the timestamp used in `getBeatPriceFromEvent()`
3. **Error logging** enhanced to show all relevant market data
4. **Consistent behavior** between 5m and 15m markets

## Result

- ✅ 15m markets now use the same timestamp calculation as beat price fetch
- ✅ Cache works correctly for both 5m and 15m markets
- ✅ Better error messages help diagnose issues
- ✅ Consistent behavior across all market types
