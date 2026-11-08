// Cards sit in even rows (DD-03): one wide card, or two side by side with the same height.
// On phones every card gets its own row. Stacked cards also open up with scroll speed (Spread).

import { Children, ReactNode } from 'react';
import { View } from 'react-native';
import { useLayout } from './layout';
import { ColumnContext, Spread } from './motion';

export function CardRow({ children }: { children: ReactNode }) {
  const { isPhone, gap } = useLayout();
  const items = Children.toArray(children);
  const sideBySide = !isPhone && items.length > 1;
  return (
    <View style={[{ gap }, sideBySide && { flexDirection: 'row' }]}>
      {items.map((child, i) => (
        <ColumnContext.Provider key={i} value={i}>
          {/* Side by side: flex 1 = equal widths, and the row's alignItems 'stretch' = equal heights.
              Stacked: offsets centred on 0, so the gap between them widens with scroll speed. */}
          <Spread offset={sideBySide ? 0 : i - (items.length - 1) / 2} style={sideBySide ? { flex: 1, minWidth: 0 } : undefined}>
            {child}
          </Spread>
        </ColumnContext.Provider>
      ))}
    </View>
  );
}

// Two cards stacked in one column of a row; the second one stretches to fill the height
// (the mock-up's "auto 1fr"), so the column matches the card next to it.
export function CardStack({ top, bottom }: { top: ReactNode; bottom: ReactNode }) {
  const { gap } = useLayout();
  return (
    <View style={{ gap, flexGrow: 1 }}>
      <Spread offset={-0.5}>{top}</Spread>
      <Spread offset={0.5} style={{ flexGrow: 1 }}>
        {bottom}
      </Spread>
    </View>
  );
}
