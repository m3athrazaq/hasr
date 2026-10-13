// Camera placement guide (Arabic / English) with simple diagrams.
import { getLang } from './i18n.js';

const svgOverhead = `
<svg viewBox="0 0 360 200" role="img" aria-label="overhead camera">
  <rect x="0" y="0" width="360" height="200" fill="var(--surface-2)" rx="10"/>
  <path d="M20 170 L340 120" stroke="var(--muted)" stroke-width="6" stroke-linecap="round"/>
  <path d="M20 182 L340 132" stroke="var(--line)" stroke-width="3" stroke-linecap="round"/>
  <line x1="200" y1="30" x2="200" y2="150" stroke="var(--fg)" stroke-width="5"/>
  <rect x="186" y="22" width="40" height="18" rx="4" fill="var(--fg)"/>
  <circle cx="214" cy="31" r="5" fill="var(--accent)"/>
  <path d="M206 40 L150 152 L270 132 Z" fill="var(--accent)" opacity=".18" stroke="var(--accent)" stroke-dasharray="5 4"/>
  <g fill="var(--surface)" stroke="var(--fg)" stroke-width="2">
    <ellipse cx="120" cy="150" rx="20" ry="11"/><ellipse cx="175" cy="141" rx="20" ry="11"/><ellipse cx="250" cy="130" rx="20" ry="11"/>
  </g>
  <line x1="208" y1="122" x2="214" y2="150" stroke="var(--accent)" stroke-width="5" stroke-linecap="round"/>
  <path d="M236 60 l0 70" stroke="var(--muted)" stroke-width="1.5" marker-end="url(#a)" marker-start="url(#a)"/>
  <text x="244" y="98" font-size="14" fill="var(--fg)" font-family="Readex Pro, sans-serif">3–4 m</text>
  <defs><marker id="a" viewBox="0 0 8 8" refX="4" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z" fill="var(--muted)"/></marker></defs>
</svg>`;

const svgAngle = `
<svg viewBox="0 0 360 200" role="img" aria-label="angled camera">
  <rect x="0" y="0" width="360" height="200" fill="var(--surface-2)" rx="10"/>
  <path d="M20 170 L340 150" stroke="var(--muted)" stroke-width="6" stroke-linecap="round"/>
  <line x1="40" y1="60" x2="40" y2="168" stroke="var(--fg)" stroke-width="5"/>
  <rect x="30" y="50" width="40" height="18" rx="4" fill="var(--fg)" transform="rotate(30 50 59)"/>
  <path d="M62 70 L150 162 L330 150 Z" fill="var(--accent)" opacity=".18" stroke="var(--accent)" stroke-dasharray="5 4"/>
  <g fill="var(--surface)" stroke="var(--fg)" stroke-width="2">
    <ellipse cx="170" cy="150" rx="22" ry="13"/><ellipse cx="225" cy="147" rx="22" ry="13"/><ellipse cx="285" cy="143" rx="22" ry="13"/>
  </g>
  <text x="86" y="60" font-size="14" fill="var(--fg)" font-family="Readex Pro, sans-serif">45°</text>
</svg>`;

const svgLine = `
<svg viewBox="0 0 360 170" role="img" aria-label="counting line">
  <rect x="0" y="0" width="360" height="170" fill="var(--surface-2)" rx="10"/>
  <rect x="20" y="45" width="320" height="80" fill="var(--surface)" stroke="var(--line)" stroke-width="2"/>
  <g fill="var(--surface-2)" stroke="var(--fg)" stroke-width="2">
    <ellipse cx="70" cy="70" rx="24" ry="12"/><ellipse cx="80" cy="102" rx="24" ry="12"/><ellipse cx="135" cy="86" rx="24" ry="12"/><ellipse cx="275" cy="80" rx="24" ry="12"/>
  </g>
  <line x1="205" y1="38" x2="205" y2="132" stroke="var(--accent)" stroke-width="6" stroke-linecap="round"/>
  <path d="M205 85 h36" stroke="var(--accent)" stroke-width="5"/><path d="M252 85 l-13 -9 v18 z" fill="var(--accent)"/>
  <path d="M30 152 h300" stroke="var(--muted)" stroke-width="1.5" marker-end="url(#b)"/>
  <defs><marker id="b" viewBox="0 0 8 8" refX="4" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--muted)"/></marker></defs>
</svg>`;

const C = {
  ar: {
    intro: 'الدقة تأتي أولاً من مكان الكاميرا. التطبيق يتتبع كل رأس ويعدّه عند عبور الخط، ويخصم أي رأس يرجع للخلف، ويضع الحالات المشكوك فيها أمامك للمراجعة.',
    a: { t: 'الأفضل: الكاميرا فوق الممر', items: ['ثبّت الكاميرا على عمود أو سقف على ارتفاع 3 إلى 4 أمتار فوق الرامب أو بوابة الخروج، وتنظر للأسفل.', 'يجب أن يظهر عرض الممر كاملاً، وأن يأخذ الرأس الواحد تقريباً خُمس إلى ثلث عرض الصورة.', 'اترك نوع المنظر «تلقائي»: يجرّب التطبيق نماذجه على الصورة ويختار الذي يرى الأغنام أوضح، ومنها نموذج «ممر العدّ» المدرّب على تصوير ليلي من فوق ممر ضيق.'] },
    b: { t: 'بديل: زاوية مائلة من الجانب', items: ['ارفع الجوال على حامل بارتفاع 2.5 متر على الأقل، بزاوية تقارب 45 درجة نحو الممر.', 'كلما ارتفعت الكاميرا قلّ تغطية الأغنام لبعضها.', 'اختر «مائل أو جانبي».'] },
    c: { t: 'مكان خط العدّ', items: ['أفضل مكان للخط: عند نهاية الممر، قبل أن تنتشر الأغنام في الحظيرة مباشرة، حيث تمشي واحدة تلو الأخرى وتكون واضحة تحت الإضاءة. لا تضعه أعلى الممر في الجزء المظلم أو البعيد عن الكاميرا، ولا داخل الحظيرة حيث تتجمع وتدور.', 'إذا لم ترسم خطاً، يراقب التطبيق حركة الأغنام في عدة مقاطع ويرسم الخط بالعرض على اتجاه سيرها. تأكد من مكانه واسحب طرفيه إن لزم، وأن السهم يشير إلى اتجاه خروج الأغنام.', 'أبعد مكان وقوف العمال عن الخط قدر الإمكان.'] },
    d: { t: 'الإضاءة والتشغيل', items: ['إضاءة متساوية فوق الممر، وتجنّب الشمس أو الكشافات المواجهة للعدسة.', 'في الليل استخدم كشافاً فوق الممر وليس خلفه.', 'صل الجوال بالشاحن طوال العدّ، ولا تغلق الشاشة ولا تفتح تطبيقاً آخر.', 'لا تحرّك الكاميرا بعد بدء العدّ: تحريكها يجعل الأغنام تبدو وكأنها عبرت الخط أو رجعت.', 'راقب مؤشر «جودة الرؤية»؛ إذا صار ضعيفاً حسّن الإضاءة أو قرّب الكاميرا أو حدّد «منطقة الكشف» حول الممر فقط.'] },
    e: { t: 'كاميرات المراقبة على الويندوز', items: ['افتح الكاميرا المطلوبة في برنامج المراقبة وكبّرها لتملأ النافذة.', 'في حَصْر اختر «شاشة برنامج المراقبة» ثم اختر تلك النافذة.', 'للعدّ الثاني: صدّر تسجيل نفس الفترة من جهاز التسجيل وعدّه من «عدّ من فيديو مسجّل»، ثم طابق العددين من التقرير.'] },
    f: { t: 'للوصول إلى أعلى دقة ممكنة', items: ['منفذ واحد = جهاز واحد. لعدة منافذ استخدم جهازاً لكل منفذ واجمع الأعداد.', 'اضغط «شاحنة جديدة» مع كل شاحنة؛ مطابقة كل شاحنة مع ورقة التحميل تكشف أي فرق في مكانه.', 'راجع الحالات المعلّمة قبل اعتماد العدد النهائي.', 'جرّب الإعداد قبل وصول السفينة بفيديو قصير، وأرسل لنا مقطعاً من موقعكم لتدريب النموذج على بيئتكم.'] },
  },
  en: {
    intro: 'Accuracy starts with where the camera is. The app tracks every head, counts it when it crosses the line, subtracts any that walk back, and puts doubtful cases in front of you for review.',
    a: { t: 'Best: camera above the ramp', items: ['Mount the camera on a pole or roof 3–4 m above the ramp or exit gate, looking down.', 'The full width of the passage must be visible; one head should take roughly a fifth to a third of the image width.', 'Leave the view on “Automatic”: the app tries its models on the picture and keeps the one that sees the sheep best, including the “Counting race” model trained on night footage from above a narrow race.'] },
    b: { t: 'Alternative: angled from the side', items: ['Raise the phone on a tripod at least 2.5 m high, tilted about 45° towards the passage.', 'The higher the camera, the less the sheep hide each other.', 'Choose “Angled or side”.'] },
    c: { t: 'Where to draw the line', items: ['The best place for the line is the end of the race, just before the sheep spread into the pen, where they walk one by one and are well lit. Not high up in the dark part of the race far from the camera, and not inside the pen where they bunch and turn.', 'If you do not draw a line, the app watches the sheep in several parts of the recording and draws it across their path. Check where it is, drag its ends if needed, and make sure the arrow points the way the sheep leave.', 'Keep the spot where workers stand away from the line.'] },
    d: { t: 'Light and operation', items: ['Even light over the passage; avoid sun or floodlights pointing into the lens.', 'At night light the passage from above, not from behind.', 'Keep the phone on the charger, the screen on, and stay in the app.', 'Do not move the camera once counting has started: moving it makes sheep look as if they crossed the line or walked back.', 'Watch the “Vision quality” indicator; if it drops, improve the light, move the camera closer or set a detection area around the passage only.'] },
    e: { t: 'CCTV cameras on Windows', items: ['Open the camera in the CCTV software and enlarge it to fill the window.', 'In Hasr choose “CCTV software screen” and pick that window.', 'For a second count, export the recording of the same period and count it with “Count a recorded video”, then reconcile both counts in the report.'] },
    f: { t: 'For the highest possible accuracy', items: ['One exit = one device. For several exits use one device per exit and add the totals.', 'Press “New truck” for every truck; checking each truck against its loading sheet locates any difference.', 'Review the flagged cases before signing off the final count.', 'Test the setup with a short video before the vessel arrives, and send us a clip from your site to train the model on your conditions.'] },
  },
};

export function renderGuide(el) {
  const c = C[getLang()] || C.ar;
  const sec = (s, svg) => `<figure>${svg || ''}<figcaption>${s.t}</figcaption><ul>${s.items.map((i) => `<li>${i}</li>`).join('')}</ul></figure>`;
  el.innerHTML = `<p class="tagline">${c.intro}</p>${sec(c.a, svgOverhead)}${sec(c.b, svgAngle)}${sec(c.c, svgLine)}${sec(c.d)}${sec(c.e)}${sec(c.f)}`;
}
