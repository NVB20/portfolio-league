// The trading screen (/trade), from the design artifact. One long scroll with three sections:
//   1. The order: the selected security, buy/sell + amount + an optional stop loss on a buy (D-037) + send, the
//      10-day chart, the preview card against the rules, your holding, cash, and all 40 securities to pick from
//   2. The chart: the full Lightweight Charts chart (real Yahoo OHLC) with the order center beside it
//   3. After sending: pending orders and how an order executes
//
// Data: GET /me/trade (one request) + GET /me/chart/:symbol for the full chart.
// Sending: the send button opens a confirm popup, whose button calls POST /me/orders (useSendOrder). After any answer but a
// rate limit the trade data is loaded again: a success or a lost answer changes pending orders, available cash
// and free units, and a refusal means the preview was out of date. The preview checks the same rules as the
// server when sending (D-028); the server checks them again, and the runner at the execution price.
// Opening the popup and backing out of it are counted for the admin's monitoring page (D-036, src/usage/tracker.ts).
// World time runs at real speed (D-017): when a market opens or closes, a new day begins or the clock reaches its
// end, the data is loaded again, and until it arrives nothing can be sent and no execution time is promised.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import type { SecurityView, TradeView } from '../../api/src/contract';
import { useAuth } from '../auth/AuthProvider';
import { useTheme } from '../useTheme';
import { ilsExact, pct } from '../dashboard/format';
import { marketsChanged } from '../dashboard/markets';
import { useElapsed } from '../dashboard/useElapsed';
import { checkChip, EXCHANGE, executionShort, GAME_OVER_LINE, marketLine, money, sentToast, stopBlocked, stopConfirmLine } from '../trade/copy';
import { orderBody } from '../trade/orderBody';
import { checkOrder, checkStop, clampLevel, defaultLevels, pendingBuysIls, pendingListCut, type Levels, type Side } from '../trade/orderCheck';
import { useSendOrder } from '../trade/useSendOrder';
import { useChart, useChartSettings, useTrade } from '../trade/useTrade';
import { ConfirmFunnel, usage } from '../usage/tracker';
import { Button } from '../components/dashboard/Button';
import { Card, Empty } from '../components/dashboard/Card';
import { CardRow, CardStack } from '../components/dashboard/CardRow';
import { Chip } from '../components/dashboard/Chip';
import { MAX_WIDTH } from '../components/dashboard/layout';
import { MotionProvider, OffsetProvider, useMeasure, useScrollMotion } from '../components/dashboard/motion';
import { PendingOrdersCard } from '../components/dashboard/PendingOrdersCard';
import { Accent, Section, Strong } from '../components/dashboard/Section';
import { BAR_HEIGHT, TopBar } from '../components/dashboard/TopBar';
import { BigChart } from '../components/trade/BigChart';
import type { ChartPalette } from '../components/trade/BigChart.types';
import { LevelInputs, PositionToggle, RiskReward, StatsStrip, type Measurement } from '../components/trade/OrderCenter';
import { AmountField, AmountSlider, ConfirmOrder, SendBox, SideToggle, StopLossField, Toast } from '../components/trade/OrderTicket';
import { PickerCard } from '../components/trade/PickerCard';
import { TenDayChartCard } from '../components/trade/TenDayChart';
import { CashCard, PositionCard, PreviewCard, RulesCard } from '../components/trade/TradeCards';
import { fixed } from '../theme';

const DEFAULT_SYMBOL = 'NVDA';
const DEFAULT_AMOUNT = '10000';
const TOAST_MS = 3600;
const ERROR_TOAST_MS = 6500;   // a failure has more to read
const ARM_MS = 450;            // a press this soon after the popup opened is a double-click's second click
const FRESH_MS = 60_000;       // opening the confirm step reloads data older than this (an admin clock move, ...)
const UPDATING_LINE = 'מעדכן את מועד הביצוע…';

export default function TradeScreen() {
  const { colors } = useTheme();
  const { user } = useAuth();
  const { data, error, isLoading, reload } = useTrade();
  const name = user?.displayName || user?.email?.split('@')[0] || 'שחקן';

  // A reload keeps the screen (and what the player typed): `data` stays while it loads.
  if (data) return <TradeView data={data} name={name} uid={user?.uid ?? ''} loading={isLoading} reload={reload} />;

  return (
    <View style={[styles.page, { direction: 'rtl', backgroundColor: colors.page }]}>
      <View style={styles.center}>
        {isLoading ? (
          <ActivityIndicator size="large" color={colors.accent} />
        ) : (
          <>
            <Text style={[styles.error, { color: colors.fg }]}>{error ?? 'משהו השתבש'}</Text>
            <Pressable onPress={reload} style={[styles.retry, { borderColor: colors.accent }]} accessibilityRole="button">
              <Text style={{ color: colors.accent, fontWeight: '700' }}>נסו שוב</Text>
            </Pressable>
          </>
        )}
      </View>
      <TopBar clock={null} name={name} rankLine={null} active="trade" />
    </View>
  );
}

function TradeView({ data, name, uid, loading, reload }: {
  data: TradeView;
  name: string;
  uid: string;
  loading: boolean;
  reload: () => Promise<void>;
}) {
  const { colors } = useTheme();
  const { motion, onScroll } = useScrollMotion();
  const wrap = useMeasure(0);
  const scroll = useRef<{ scrollTo: (o: { y: number; animated?: boolean }) => void } | null>(null);

  // ---------- what the player is doing ----------
  // ?symbol=TEVA (a row of the journal) opens on that security, also when this screen was already open.
  const asked = useLocalSearchParams<{ symbol?: string }>().symbol;
  const askedSymbol = data.securities.some((s) => s.symbol === asked) ? (asked as string) : null;
  const first = askedSymbol ?? data.securities.find((s) => s.holding)?.symbol ?? data.securities.find((s) => s.symbol === DEFAULT_SYMBOL)?.symbol ?? data.securities[0]?.symbol ?? null;
  const [symbol, setSymbol] = useState<string | null>(first);
  const [side, setSide] = useState<Side>('buy');
  const [amountText, setAmountText] = useState(DEFAULT_AMOUNT);
  const [posOn, setPosOn] = useState(true);
  const [stopOn, setStopOn] = useState(false);   // the optional stop loss on a buy (D-037)
  const [measurement, setMeasurement] = useState<Measurement | null>(null);
  // A new ?symbol= while the screen is open: switch to it during render (React's "adjust state when a value changes").
  const [lastAsked, setLastAsked] = useState(askedSymbol);
  if (askedSymbol !== lastAsked) {
    setLastAsked(askedSymbol);
    if (askedSymbol) {
      setSymbol(askedSymbol);
      setMeasurement(null);
    }
  }
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sec = data.securities.find((s) => s.symbol === symbol) ?? null;
  const usdRate = data.usdIls?.rate ?? null;
  const toIls = sec?.currency === 'USD' ? usdRate ?? 0 : 1;
  const priceIls = sec?.price != null && toIls > 0 ? sec.price * toIls : null;
  const heldIls = sec?.holding?.valueIls ?? 0;
  const amount = Number(amountText) || 0;
  const pending = sec ? pendingBuysIls(data.pendingOrders, sec.symbol) : 0;
  const check = checkOrder({
    side,
    amount,
    availableCash: data.availableCash,
    totalValue: data.totalValue,
    holding: sec?.holding ?? null,
    pendingBuysIls: pending,
    pendingCut: pendingListCut(data.pendingOrders),
    priceIls,
    gameOver: sec?.execution?.gameOver ?? false,
  });
  const today = data.clock?.date ?? null;
  const session = sec && data.clock ? data.clock.markets[sec.market === 'TASE' ? 'tase' : 'us'] : null;

  // The position tool starts at the latest price, +8% target and −4% stop. Its stop is the order's stop loss when
  // the player turns that on (D-037). A new price (a market event) starts the tool again, but not while the stop
  // loss is on: that would move a stop the player chose without telling them. A new security always does.
  const [levels, setLevels] = useState<Levels>(() => defaultLevels(sec?.price ?? 1));
  // Adjusted during render when the security or its price changes (React's "adjust state when a value changes").
  const [levelsFor, setLevelsFor] = useState({ symbol: sec?.symbol, price: sec?.price });
  if (levelsFor.symbol !== sec?.symbol || levelsFor.price !== sec?.price) {
    const newSymbol = levelsFor.symbol !== sec?.symbol;
    setLevelsFor({ symbol: sec?.symbol, price: sec?.price });
    if (sec?.price && (newSymbol || !stopOn)) setLevels(defaultLevels(sec.price));
  }
  const onLevel = useCallback((k: keyof Levels, v: number) => setLevels((l) => clampLevel(l, k, v)), []);
  const onStop = useCallback((v: number) => setLevels((l) => clampLevel(l, 'stop', v)), []);
  // A sell has no stop loss; the server would refuse one (D-037).
  const stop = checkStop(side === 'buy' && stopOn ? levels.stop : null, sec?.price ?? null, amount);
  const canSend = check.ok && stop.ok;

  // ---------- chart data + settings ----------
  const { settings, change, savedAt } = useChartSettings(data.chartSettings);
  const tf = settings?.tf ?? 'D';
  const { chart, error: chartError } = useChart(sec?.hasChart ? sec.symbol : null, tf);
  const shown = useMemo(() => {
    if (!chart || !settings) return [];
    const n = tf === 'W' ? Math.ceil(settings.range / 5) : settings.range;
    return chart.bars.slice(-n);
  }, [chart, settings, tf]);

  const palette = useMemo<ChartPalette>(
    () => ({
      bg: colors.surface, fg: colors.faint, fg2: colors.fg, grid: colors.line, border: colors.line2,
      surface: colors.surface, surface2: colors.surface2, line: colors.line, line2: colors.line2,
      muted: colors.muted, text: colors.fg, faint: colors.faint,
      accent: colors.accent, accentInk: colors.accentInk, accentTint: colors.accentTint,
      warn: fixed.warnFill, warnInk: fixed.warnFillInk,
    }),
    [colors],
  );

  // ---------- actions ----------
  const showToast = useCallback((msg: string, ms = TOAST_MS) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), ms);
  }, []);
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const pick = (s: string) => {
    setSymbol(s);
    setMeasurement(null);
    scroll.current?.scrollTo({ y: 0, animated: true });
  };
  const toTicket = () => scroll.current?.scrollTo({ y: 0, animated: true });

  // ---------- the live clock ----------
  // The loaded data describes one moment. Once a market opens or closes (or a new day, or the end), load again;
  // a failed load is tried again on the next tick. Until it arrives, `moved` blocks sending.
  const elapsed = useElapsed(data.clock);
  const moved = data.clock ? marketsChanged(data.clock, elapsed) : false;
  const loadingNow = useRef(loading);
  loadingNow.current = loading;
  useEffect(() => {
    if (moved && !loadingNow.current) void reload();
  }, [moved, elapsed, reload]);
  const loadedAt = useMemo(() => Date.now(), [data]);

  // ---------- sending ----------
  const { busy, prepare, send } = useSendOrder(uid);
  const updating = loading || moved;   // the preview may be out of date: nothing is sent against it
  const body = sec && canSend ? orderBody({ symbol: sec.symbol, side, amount, sell: check.sell, stop: stop.stop }) : null;
  const orderKey = `${symbol}:${side}:${amountText}:${stop.stop ?? ''}`;

  // One confirm popup for both send buttons (the ticket and the order center).
  // Any change to the order (side, amount, security) closes it.
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const openedAt = useRef(0);

  // The admin's popup funnel (D-036) counts every opening, and every close without a send by the player's choice:
  // back, a tap outside, Escape, a change to the order, or leaving the screen with it open. A send is not one, and
  // neither is a failed send that closes it with a toast, a send still on its way, or one that got no answer.
  // ConfirmFunnel (src/usage/tracker.ts) holds those rules and counts one opening as a back-out at most once.
  const [funnel] = useState(() => new ConfirmFunnel(usage));
  const shutConfirm = useCallback((backedOut: boolean) => {
    funnel.closed(backedOut);
    setConfirming(false);
  }, [funnel]);
  useEffect(() => shutConfirm(true), [orderKey, shutConfirm]);
  useEffect(() => () => funnel.closed(true), [funnel]);

  // A double-click on a send button must neither send nor close the popup with its second click.
  const armed = () => Date.now() - openedAt.current >= ARM_MS;

  const openConfirm = () => {
    openedAt.current = Date.now();
    funnel.opened();
    setConfirmError(null);
    setConfirming(true);
    prepare(orderKey, body);
    if (Date.now() - loadedAt > FRESH_MS && !loading) void reload();
  };
  const closeConfirm = () => {
    if (busy || !armed()) return;   // an order on its way: wait for its answer
    shutConfirm(true);
  };
  const confirm = async () => {
    if (!armed()) return;
    setConfirmError(null);
    const answered = funnel.send();
    const out = await send(orderKey, body);
    // Stored, or no answer (it may be stored): closing the popup after this is no back-out.
    answered(out !== null && (out.ok || out.outcome === 'unknown'));
    if (!out) return;   // a send is already on its way, or nothing to send
    if (out.ok) {
      shutConfirm(false);
      showToast(sentToast(out.result, today));
      void reload();    // pending orders, available cash and free units
      return;
    }
    // After a refusal the preview was out of date; after no answer the order may be pending. The reload keeps
    // orderKey, so after no answer the popup stays open with the reason, and pressing again resends the same
    // body and id. Any other failure closes it and says why in a toast.
    if (out.reload) void reload();
    if (out.retry) return setConfirmError(out.message);
    shutConfirm(false);
    showToast(out.message, ERROR_TOAST_MS);
  };

  const execLine = moved
    ? UPDATING_LINE
    : !sec?.execution
      ? ''
      : sec.execution.gameOver
        ? GAME_OVER_LINE
        : `${executionShort(sec.execution, today)} · ${EXCHANGE[sec.exchange]}`;
  const sendBox = <SendBox side={side} ok={canSend} sending={busy} updating={updating} onOpen={openConfirm} />;

  if (!sec) {
    return (
      <View style={[styles.page, { direction: 'rtl', backgroundColor: colors.page }]}>
        <View style={[styles.wrap, styles.emptyWorld]}>
          <Card title="העולם עוד לא נטען" sub="אין עדיין ניירות במשחק">
            <Empty>מנהל המשחק טוען את 40 הניירות והמחירים (npm run seed:world). אחרי זה המסחר ייפתח כאן.</Empty>
          </Card>
        </View>
        <TopBar clock={data.clock} name={name} rankLine={null} active="trade" />
      </View>
    );
  }

  const us = sec.currency === 'USD';
  // One stop-loss field, shown in the ticket and in the order center; both edit the same stop.
  const stopField = side === 'buy' ? (
    <StopLossField on={stopOn} onToggle={() => setStopOn((o) => !o)} stop={levels.stop} currency={sec.currency} check={stop} onStop={onStop} disabled={busy} />
  ) : null;
  const ticket = (
    <View style={styles.ticket}>
      <SideToggle side={side} onChange={setSide} disabled={busy} />
      <View>
        <AmountField value={amountText} onChange={setAmountText} disabled={busy} />
        <AmountSlider side={side} value={amount} max={check.maxIls} onPick={(v) => setAmountText(String(v))} disabled={busy} />
      </View>
      {stopField}
      {sendBox}
    </View>
  );

  return (
    <MotionProvider value={motion}>
      <View style={[styles.page, { direction: 'rtl', backgroundColor: colors.page }]}>
        <Animated.ScrollView ref={scroll as never} contentContainerStyle={styles.scroll} onScroll={onScroll} scrollEventThrottle={16}>
          <View style={styles.wrap} onLayout={wrap.onLayout}>
            <OffsetProvider value={wrap.abs}>
              {/* 1. The order */}
              <Section
                first
                eyebrow={`מסחר · מזומן זמין ${ilsExact(data.availableCash)}`}
                title={
                  <>
                    <Text style={[styles.pill, { color: us ? colors.muted : colors.accent, backgroundColor: us ? colors.surface2 : colors.accentTint }]}>{` ${sec.symbol} `}</Text>
                    {'\n'}
                    <Strong>{sec.nameHe}</Strong>
                  </>
                }
                body={
                  <View style={styles.priceBlock}>
                    <View style={styles.priceRow}>
                      <Text style={[styles.price, { color: colors.fg }]}>{sec.price === null ? '–' : money(sec.price, sec.currency)}</Text>
                      {sec.dayChangePct !== null ? (
                        <Chip variant={sec.dayChangePct >= 0 ? 'up' : 'down'}>{`${sec.dayChangePct >= 0 ? '▲' : '▼'} ${pct(Math.abs(sec.dayChangePct), { digits: 1, signed: false })} ביום האחרון`}</Chip>
                      ) : null}
                    </View>
                    <View style={styles.mkt}>
                      <View style={[styles.dot, { backgroundColor: sec.isOpen ? colors.accent : colors.faint }]} />
                      <Text style={[styles.mktText, { color: colors.faint }]}>{moved ? UPDATING_LINE : marketLine(sec, today, session)}</Text>
                    </View>
                  </View>
                }
                actions={ticket}
              >
                <CardRow>
                  <TenDayChartCard security={sec} today={today} />
                </CardRow>
                <CardRow>
                  <PreviewCard
                    security={sec}
                    side={side}
                    amount={amount}
                    check={check}
                    stop={stop}
                    availableCash={data.availableCash}
                    pendingBuysIls={pending}
                    usdRate={usdRate}
                    onSend={toTicket}
                  />
                  <CardStack
                    top={<PositionCard security={sec} />}
                    bottom={<CashCard cash={data.cash} availableCash={data.availableCash} totalValue={data.totalValue} usd={data.usdIls} />}
                  />
                </CardRow>
                <CardRow>
                  <PickerCard securities={data.securities} selected={sec.symbol} onPick={pick} taseOpen={data.clock?.markets.tase.isOpen ?? false} disabled={busy} />
                </CardRow>
              </Section>

              {/* 2. The chart + the order center */}
              <Section
                alt
                eyebrow={`מרכז הפקודות · ${sec.symbol}`}
                title={
                  <>
                    {'תכנן על הגרף.\n'}
                    <Accent>ואז שלח.</Accent>
                  </>
                }
                body="כלי הפוזיציה מצייר כניסה, יעד וסטופ לסכום הפקודה. גרור את התוויות על הגרף או הקלד מחירים כאן. הסטופ יכול לצאת עם הפקודה כסטופ לוס."
                actions={
                  <View style={styles.center2}>
                    <SideToggle side={side} onChange={setSide} disabled={busy} />
                    <AmountField value={amountText} onChange={setAmountText} compact disabled={busy} />
                    <PositionToggle on={posOn} onToggle={() => setPosOn((o) => !o)} />
                    <LevelInputs levels={levels} currency={sec.currency} onChange={onLevel} />
                    <RiskReward amount={amount} levels={levels} currency={sec.currency} entryIls={levels.entry * toIls} />
                    {stopField}
                    <Text style={[styles.note, { color: colors.faint }]}>
                      {side === 'sell'
                        ? 'כלי הפוזיציה מתכנן קנייה (לונג). במשחק אין שורט.'
                        : 'היעד לתכנון בלבד. הסטופ נשלח עם הפקודה כשהסטופ לוס מופעל, ונבדק רק בשער הפתיחה והסגירה.'}
                    </Text>
                    {sendBox}
                  </View>
                }
              >
                <CardRow>
                  <Card title={`${sec.nameHe} · ${tf === 'W' ? 'שבועי' : 'יומי'}`} sub={`נתוני OHLC אמיתיים · ${EXCHANGE[sec.exchange]} · ${us ? 'דולרים' : 'שקלים'} · עד הסגירה האחרונה בשעון המשחק`}>
                    {settings ? (
                      <BigChart
                        symbol={sec.symbol}
                        currency={sec.currency}
                        bars={sec.hasChart ? chart?.bars ?? null : []}
                        error={chartError}
                        settings={settings}
                        onSettings={change}
                        savedAt={savedAt}
                        palette={palette}
                        levels={levels}
                        onLevels={setLevels}
                        onLevel={onLevel}
                        posOn={posOn}
                        onPosToggle={() => setPosOn((o) => !o)}
                        amountIls={amount}
                        toIls={toIls}
                        onMeasure={setMeasurement}
                      />
                    ) : null}
                  </Card>
                </CardRow>
                <CardRow>
                  <StatsStrip bars={shown} currency={sec.currency} tf={tf} amount={amount} heldIls={heldIls} symbol={sec.symbol} measurement={measurement} />
                </CardRow>
              </Section>

              {/* 3. After sending */}
              <Section
                eyebrow="אחרי השליחה"
                title={
                  <>
                    {'הפקודה מחכה\n'}
                    <Accent>לשער הבא.</Accent>
                  </>
                }
                body="אתה לא קובע מחיר. פקודה שנשלחה כשהשוק פתוח מתבצעת בשער הסגירה של היום. כשהשוק סגור, בשער הפתיחה של יום המסחר הבא."
                actions={<Button label="ליומן המסחר" onPress={() => router.navigate('/journal?filter=pending')} hint="כל הפקודות ששלחת ומה קרה להן" />}
              >
                <CardRow>
                  <PendingOrdersCard orders={{ total: data.pendingOrders.length, next: data.pendingOrders }} today={today} />
                  <RulesCard />
                </CardRow>
              </Section>
            </OffsetProvider>
            <Text style={[styles.footer, { color: colors.faint, borderTopColor: colors.line }]}>
              שעון העולם · תל אביב 10:00–17:30 (יום ו׳ עד 13:50) · ניו יורק 16:30–23:00 שעון ישראל · כל השחקנים חיים באותו שעון.
            </Text>
          </View>
        </Animated.ScrollView>

        <Toast message={toast} />
        <TopBar clock={data.clock} name={name} rankLine={null} active="trade" />
        <ConfirmOrder
          open={confirming}
          side={side}
          symbol={sec.symbol}
          name={sec.nameHe}
          amount={amount}
          units={check.units}
          execLine={execLine}
          stopLine={stopConfirmLine(stop, sec.currency)}
          ok={canSend}
          blocked={check.ok ? stopBlocked(stop) : checkChip(check).label}
          error={confirmError}
          sending={busy}
          updating={updating}
          onBack={closeConfirm}
          onConfirm={confirm}
        />
      </View>
    </MotionProvider>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  scroll: { paddingTop: BAR_HEIGHT, paddingBottom: 110 },
  wrap: { width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center', paddingHorizontal: 16 },
  emptyWorld: { paddingTop: BAR_HEIGHT + 56 },
  footer: { paddingTop: 32, borderTopWidth: 1, fontSize: 13 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  error: { fontSize: 16 },
  retry: { borderWidth: 1.5, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 24 },
  pill: { fontSize: 16, fontWeight: '600', borderRadius: 8 },
  priceBlock: { marginTop: 12 },
  priceRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10 },
  price: { fontSize: 38, fontWeight: '500', letterSpacing: -0.5, fontVariant: ['tabular-nums'] },
  mkt: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  mktText: { fontSize: 12.5 },
  ticket: { width: '100%', maxWidth: 320, gap: 14 },
  center2: { width: '100%', maxWidth: 380, gap: 12 },
  note: { fontSize: 11.5 },
});
