/**
 * Accessible board: drag or tap-tap to move (touch friendly), keyboard move entry (SAN or UCI),
 * a screen-reader description of the position, colour-blind-safe themes.
 */
import { useMemo, useState, type CSSProperties, type ReactElement } from 'react';
import { Chessboard } from 'react-chessboard';
import { Chess, type Square } from 'chess.js';
import { uciOf } from '../engine/chessUtil';
import type { BoardTheme } from '../model/settings';

export const THEMES: Record<BoardTheme, { light: string; dark: string; select: string; hint: string; label: string }> = {
  classic: { light: '#eeeed2', dark: '#769656', select: 'rgba(255, 210, 0, 0.55)', hint: 'rgba(20, 85, 200, 0.45)', label: 'Classic green' },
  'blue-orange': { light: '#dfe7ef', dark: '#5b7ea4', select: 'rgba(230, 120, 0, 0.6)', hint: 'rgba(230, 120, 0, 0.35)', label: 'Blue / orange (colour-blind safe)' },
  'high-contrast': { light: '#ffffff', dark: '#5a5a5a', select: 'rgba(255, 200, 0, 0.75)', hint: 'rgba(0, 90, 255, 0.5)', label: 'High contrast' },
  mono: { light: '#d9d9d9', dark: '#8c8c8c', select: 'rgba(0, 0, 0, 0.3)', hint: 'rgba(0, 0, 0, 0.18)', label: 'Monochrome' },
};

const NAMES: Record<string, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

export function describePosition(fen: string): string {
  try {
    const chess = new Chess(fen);
    const parts: string[] = [];
    for (const color of ['w', 'b'] as const) {
      const pieces: string[] = [];
      for (const row of chess.board()) for (const sq of row) if (sq && sq.color === color) pieces.push(`${NAMES[sq.type]} ${sq.square}`);
      parts.push(`${color === 'w' ? 'White' : 'Black'}: ${pieces.join(', ') || 'none'}`);
    }
    return `${parts.join('. ')}. ${chess.turn() === 'w' ? 'White' : 'Black'} to move.`;
  } catch {
    return 'Empty board.';
  }
}

export interface BoardProps {
  fen: string;
  orientation: 'white' | 'black';
  /** Return true when the move was accepted. Called with UCI (promotion defaults to queen). */
  onMove?: (uci: string) => boolean;
  /** Square clicks for square-picking drills. */
  onSquare?: (square: string) => void;
  interactive: boolean;
  theme: BoardTheme;
  highlight?: string[];
  hidePieces?: boolean;
  hideLabels?: boolean;
  arrows?: { from: string; to: string; color?: string }[];
  label?: string;
}

export function Board(props: BoardProps): ReactElement {
  const { fen, orientation, onMove, onSquare, interactive, theme, highlight = [], hidePieces, hideLabels, arrows = [] } = props;
  const [selected, setSelected] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const colors = THEMES[theme] ?? THEMES.classic;
  const chess = useMemo(() => {
    try {
      return new Chess(fen);
    } catch {
      return null;
    }
  }, [fen]);
  const targets = useMemo(() => {
    if (!chess || !selected) return [];
    try {
      return chess.moves({ square: selected as Square, verbose: true }).map((m) => m.to);
    } catch {
      return [];
    }
  }, [chess, selected]);

  const tryUci = (from: string, to: string): boolean => {
    if (!chess || !onMove) return false;
    const legal = chess.moves({ verbose: true }).filter((m) => m.from === from && m.to === to);
    if (legal.length === 0) return false;
    const m = legal.find((x) => !x.promotion || x.promotion === 'q') ?? legal[0]!;
    return onMove(uciOf(m));
  };

  const squareStyles: Record<string, CSSProperties> = {};
  for (const s of highlight) squareStyles[s] = { background: colors.hint };
  for (const s of targets) squareStyles[s] = { ...squareStyles[s], boxShadow: `inset 0 0 0 4px ${colors.hint}` };
  if (selected) squareStyles[selected] = { background: colors.select };

  const clickSquare = (square: string): void => {
    if (onSquare) {
      onSquare(square);
      return;
    }
    if (!interactive || !chess) return;
    if (selected && selected !== square) {
      if (tryUci(selected, square)) {
        setSelected(null);
        return;
      }
    }
    const piece = chess.get(square as Square);
    setSelected(piece && piece.color === chess.turn() ? square : null);
  };

  const submitTyped = (): void => {
    if (!chess || !onMove) return;
    const text = typed.trim();
    if (!text) return;
    let uci: string | null;
    if (/^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(text)) {
      const probe = new Chess(chess.fen());
      try {
        const m = probe.move({ from: text.slice(0, 2).toLowerCase(), to: text.slice(2, 4).toLowerCase(), promotion: text[4]?.toLowerCase() ?? 'q' });
        uci = uciOf(m);
      } catch {
        uci = null;
      }
    } else {
      const probe = new Chess(chess.fen());
      try {
        uci = uciOf(probe.move(text));
      } catch {
        uci = null;
      }
    }
    if (!uci) {
      setError(`"${text}" is not a legal move here.`);
      return;
    }
    setError('');
    setTyped('');
    onMove(uci);
  };

  const position = hidePieces ? '8/8/8/8/8/8/8/8' : fen.split(' ')[0];
  return (
    <div className="board-wrap">
      <div
        className="board"
        role="img"
        aria-label={props.label ?? (hidePieces ? 'Board with pieces hidden.' : describePosition(fen))}
        data-testid="board"
        data-fen={fen}
      >
        <Chessboard
          options={{
            id: 'main',
            position,
            boardOrientation: orientation,
            allowDragging: interactive && !hidePieces && !onSquare,
            showNotation: !hideLabels,
            lightSquareStyle: { backgroundColor: colors.light },
            darkSquareStyle: { backgroundColor: colors.dark },
            squareStyles,
            arrows: arrows.map((a) => ({ startSquare: a.from, endSquare: a.to, color: a.color ?? colors.hint })),
            allowDrawingArrows: false,
            animationDurationInMs: 180,
            onPieceDrop: ({ sourceSquare, targetSquare }) => {
              if (!targetSquare) return false;
              setSelected(null);
              return tryUci(sourceSquare, targetSquare);
            },
            onSquareClick: ({ square }) => clickSquare(square),
          }}
        />
      </div>
      {interactive && onMove && (
        <form
          className="move-entry"
          onSubmit={(e) => {
            e.preventDefault();
            submitTyped();
          }}
        >
          <label htmlFor="move-input">Type a move</label>
          <input
            id="move-input"
            data-testid="move-input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="e.g. Nf3 or g1f3"
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit">Play</button>
          {error && (
            <span role="alert" className="error">
              {error}
            </span>
          )}
        </form>
      )}
    </div>
  );
}
