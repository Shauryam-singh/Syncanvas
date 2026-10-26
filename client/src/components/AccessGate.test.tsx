import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useSceneStore } from '../store/sceneStore';
import { AccessGate } from './AccessGate';

afterEach(() => {
  cleanup();
  useSceneStore.setState({ access: 'local' });
});

describe('AccessGate', () => {
  it('renders the editor while access is local or granted', () => {
    useSceneStore.setState({ access: 'local' });
    render(
      <AccessGate>
        <div>editor</div>
      </AccessGate>,
    );
    expect(screen.queryByText('editor')).not.toBeNull();
  });

  it('parks a signed-out guest at the name gate', () => {
    useSceneStore.setState({ access: 'signedout' });
    render(
      <AccessGate>
        <div>editor</div>
      </AccessGate>,
    );

    expect(screen.queryByText('editor')).toBeNull();
    expect(screen.queryByText('You have left the room')).not.toBeNull();
    expect(screen.queryByLabelText('Display name')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Enter the demo room' })).not.toBeNull();
  });
});
