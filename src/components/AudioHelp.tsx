// 효과음·배경음악을 사장님이 직접 늘리는 방법 안내.
// 실제 mp3는 웹이 아니라 PC(build_shorts.py)가 섞기 때문에, 웹에서는 칸만 고르고
// 파일은 PC의 "음원넣기.bat"으로 넣는다. 그 흐름을 화면에서 바로 알 수 있게 한다.

const FREE_SOURCES = [
  {
    name: "Pixabay 효과음",
    href: "https://pixabay.com/sound-effects/",
    note: "상업 이용 OK · 출처 표기 필요 없음",
  },
  {
    name: "Pixabay 음악",
    href: "https://pixabay.com/music/",
    note: "상업 이용 OK · 출처 표기 필요 없음",
  },
  {
    name: "FreePD",
    href: "https://freepd.com/",
    note: "기존 기본 음악 4곡의 출처",
  },
  {
    name: "Mixkit",
    href: "https://mixkit.co/free-sound-effects/",
    note: "무료 라이선스 · 상업 이용 OK",
  },
];

export const AudioHelp = () => (
  <details className="mt-2 rounded-lg border border-zinc-200 px-3 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
    <summary className="cursor-pointer font-medium text-zinc-700 dark:text-zinc-300">
      🎵 원하는 효과음·배경음악을 직접 넣고 싶다면
    </summary>
    <ol className="mt-2 list-decimal space-y-1 pl-4">
      <li>아래 무료 사이트에서 마음에 드는 소리를 내려받아요 (mp3·wav 다 돼요).</li>
      <li>
        PC의 프로젝트 폴더에서 <b>음원넣기.bat</b>을 더블클릭해요. 받은 파일을 그
        아이콘 위에 끌어다 놓아도 돼요.
      </li>
      <li>
        번호로 <b>어느 칸에 넣을지</b>만 고르면 끝이에요. 예: &ldquo;공포&rdquo;
        음악 칸, &ldquo;내 효과음 1&rdquo; 칸.
      </li>
      <li>이 화면에서 그 칸을 고르고 영상을 뽑으면 방금 넣은 소리가 나와요.</li>
    </ol>
    <ul className="mt-2 space-y-0.5">
      {FREE_SOURCES.map((source) => (
        <li key={source.href}>
          <a
            href={source.href}
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-zinc-900 dark:hover:text-zinc-100"
          >
            {source.name}
          </a>{" "}
          — {source.note}
        </li>
      ))}
    </ul>
    <p className="mt-2 text-zinc-500">
      공포·슬픔·여행·로파이 등 기본 음악은 파일을 따로 넣지 않아도 바로 쓸 수 있어요.
      &ldquo;내 음악&rdquo; 칸이 비어 있으면 기본 음악이 대신 나와요. 사이트마다 약관이 바뀔 수 있으니, 크몽 납품처럼
      돈 받고 파는 영상에는 받을 때 &ldquo;상업적 이용 가능&rdquo;인지 한 번 확인해 주세요.
    </p>
  </details>
);
