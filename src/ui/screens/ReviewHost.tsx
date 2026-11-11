import type { ReactElement } from 'react';
import Review from './Review';
import { useApp } from '../store';
import type { Exercise } from '../../exercises/types';

export default function ReviewHost({ onPractise }: { onPractise(ex: Exercise[]): void }): ReactElement {
  const theme = useApp((s) => s.settings.boardTheme);
  return <Review theme={theme} onPractise={onPractise} />;
}
