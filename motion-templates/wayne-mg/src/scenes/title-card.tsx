import {Rect, Txt, makeScene2D} from '@motion-canvas/2d';
import {all, createRef, waitFor} from '@motion-canvas/core';

export default makeScene2D(function* (view) {
  const panel = createRef<Rect>();
  const title = createRef<Txt>();
  const subtext = createRef<Txt>();

  view.add(
    <Rect
      ref={panel}
      width={1320}
      height={430}
      radius={28}
      fill={'#111711'}
      stroke={'#f58c53'}
      lineWidth={5}
      opacity={0}
      y={36}
    >
      <Txt ref={title} text={'Hook 标题卡'} fontSize={92} fontWeight={800} fill={'#f1f3ea'} y={-38} opacity={0} />
      <Txt ref={subtext} text={'用一句话呈现真实视频中的重点'} fontSize={42} fontWeight={600} fill={'#c6f475'} y={82} opacity={0} />
    </Rect>,
  );

  yield* all(
    panel().opacity(1, 0.25),
    panel().y(0, 0.35),
    title().opacity(1, 0.25),
    title().y(-28, 0.3),
  );
  yield* subtext().opacity(1, 0.2);
  yield* waitFor(1.8);
  yield* all(panel().opacity(0, 0.2), title().opacity(0, 0.15), subtext().opacity(0, 0.15));
});
