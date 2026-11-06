// The research the Strategy Lab's rules come from. Each strategy and filter in
// library.ts cites one or more of these; the Lab shows them beside its results.

export interface Paper {
  id: string;
  cite: string;
  title: string;
  venue: string;
  /** SSRN abstract id, where the paper is on SSRN */
  ssrn?: string;
  /** what it found, in one line */
  finding: string;
}

export const PAPERS: Record<string, Paper> = {
  ks151: {
    id: 'ks151',
    cite: 'Kakushadze & Serur (2018)',
    title: '151 Trading Strategies',
    venue: 'Palgrave Macmillan; SSRN working paper',
    ssrn: '3247865',
    finding: 'A catalogue of 151 strategies across asset classes with formulas: moving-average and channel rules, support and resistance, mean reversion, pairs, carry, and an ANN and sentiment strategy for bitcoin.',
  },
  mop12: {
    id: 'mop12',
    cite: 'Moskowitz, Ooi & Pedersen (2012)',
    title: 'Time series momentum',
    venue: 'Journal of Financial Economics 104(2)',
    finding: "An asset's own past 1–12 month return predicts its next month's return across 58 futures markets; reverses partly over longer horizons.",
  },
  lt21: {
    id: 'lt21',
    cite: 'Liu & Tsyvinski (2021)',
    title: 'Risks and returns of cryptocurrency',
    venue: 'Review of Financial Studies 34(6)',
    finding: 'Bitcoin returns show strong time-series momentum at one- to four-week horizons and are predicted by investor attention; they load little on stock or macro factors.',
  },
  ltw22: {
    id: 'ltw22',
    cite: 'Liu, Tsyvinski & Wu (2022)',
    title: 'Common risk factors in cryptocurrency',
    venue: 'Journal of Finance 77(2)',
    finding: 'Three factors — market, size and momentum — capture the cross-section of cryptocurrency returns.',
  },
  blr92: {
    id: 'blr92',
    cite: 'Brock, Lakonishok & LeBaron (1992)',
    title: 'Simple technical trading rules and the stochastic properties of stock returns',
    venue: 'Journal of Finance 47(5)',
    finding: 'Moving-average and trading-range-break rules earned returns that standard null models (random walk, AR, GARCH) cannot explain.',
  },
  dlszz21: {
    id: 'dlszz21',
    cite: 'Detzel, Liu, Strauss, Zhou & Zhu (2021)',
    title: 'Learning and predictability via technical analysis: evidence from bitcoin and stocks with hard-to-value fundamentals',
    venue: 'Financial Management 50(1)',
    finding: 'Ratios of price to its moving averages forecast bitcoin returns in and out of sample; rational learning about hard-to-value fundamentals explains it.',
  },
  hu21: {
    id: 'hu21',
    cite: 'Hudson & Urquhart (2021)',
    title: 'Technical trading and cryptocurrencies',
    venue: 'Annals of Operations Research 297',
    finding: 'Of almost 15,000 technical rules tested on major cryptocurrencies, many show significant predictability even after data-snooping corrections.',
  },
  cels19: {
    id: 'cels19',
    cite: 'Corbet, Eraslan, Lucey & Sensoy (2019)',
    title: 'The effectiveness of technical trading rules in cryptocurrency markets',
    venue: 'Finance Research Letters 31',
    finding: 'Variable moving-average and trading-range-break rules were profitable on high-frequency bitcoin data.',
  },
  gas20: {
    id: 'gas20',
    cite: 'Grobys, Ahmed & Sapkota (2020)',
    title: 'Technical trading rules in the cryptocurrency market',
    venue: 'Finance Research Letters 32',
    finding: 'Simple moving-average rules beat buy-and-hold on most large cryptocurrencies (not bitcoin) before costs.',
  },
  suw22: {
    id: 'suw22',
    cite: 'Shen, Urquhart & Wang (2022)',
    title: 'Bitcoin intraday time series momentum',
    venue: 'Financial Review 57(2)',
    finding: "The day's return up to late in the trading day predicts bitcoin's return in the last half hour.",
  },
  wbxz22: {
    id: 'wbxz22',
    cite: 'Wen, Bouri, Xu & Zhao (2022)',
    title: 'Intraday return predictability in the cryptocurrency markets: momentum, reversal, or both',
    venue: 'North American Journal of Economics and Finance 62',
    finding: 'Intraday momentum and reversal both appear in crypto, depending on jumps and liquidity.',
  },
  dob23: {
    id: 'dob23',
    cite: 'Dobrynskaya (2023)',
    title: 'Cryptocurrency momentum and reversal',
    venue: 'Journal of Alternative Investments 26(1)',
    finding: 'Cryptocurrencies show momentum over two to four weeks and reversal after about a month; the weekly winners reverse.',
  },
  cp19: {
    id: 'cp19',
    cite: 'Caporale & Plastun (2019)',
    title: 'The day of the week effect in the cryptocurrency market',
    venue: 'Finance Research Letters 31',
    finding: 'Bitcoin returns were higher on Mondays than on other days; most other coins show no weekday anomaly.',
  },
  hmrw22: {
    id: 'hmrw22',
    cite: 'He, Manela, Ross & von Wachter (2022)',
    title: 'Fundamentals of perpetual futures',
    venue: 'Working paper, SSRN',
    finding: 'Perpetual futures trade away from spot; the gap and the funding it implies are large and predictable, and a trade that collects funding earns high Sharpe ratios.',
  },
  crszj23: {
    id: 'crszj23',
    cite: 'Christin, Routledge, Soska & Zetlin-Jones (2023)',
    title: 'The crypto carry trade',
    venue: 'Working paper, SSRN',
    finding: 'Shorting perpetuals when funding is high (and holding spot) earns a carry premium; the premium rises with retail leverage demand.',
  },
  mm17: {
    id: 'mm17',
    cite: 'Moreira & Muir (2017)',
    title: 'Volatility-managed portfolios',
    venue: 'Journal of Finance 72(4)',
    finding: 'Taking less risk when recent volatility is high raises Sharpe ratios, because volatility does not predict higher returns.',
  },
  bsc15: {
    id: 'bsc15',
    cite: 'Barroso & Santa-Clara (2015)',
    title: 'Momentum has its moments',
    venue: 'Journal of Financial Economics 116(1)',
    finding: "Momentum's crashes come in high-volatility regimes; scaling by its own volatility nearly doubles its Sharpe ratio.",
  },
  fab07: {
    id: 'fab07',
    cite: 'Faber (2007)',
    title: 'A quantitative approach to tactical asset allocation',
    venue: 'Journal of Wealth Management 9(4)',
    finding: 'Holding an asset only while it trades above its 10-month moving average keeps most of the return with much smaller drawdowns.',
  },
  jeg90: {
    id: 'jeg90',
    cite: 'Jegadeesh (1990)',
    title: 'Evidence of predictable behavior of security returns',
    venue: 'Journal of Finance 45(3)',
    finding: 'Short-horizon returns reverse: last month’s losers beat last month’s winners.',
  },
  lm90: {
    id: 'lm90',
    cite: 'Lo & MacKinlay (1990)',
    title: 'When are contrarian profits due to stock market overreaction?',
    venue: 'Review of Financial Studies 3(2)',
    finding: 'Contrarian profits come partly from overreaction and partly from lead-lag effects; a weighted contrarian strategy is profitable at weekly horizons.',
  },
  wil78: {
    id: 'wil78',
    cite: 'Wilder (1978)',
    title: 'New Concepts in Technical Trading Systems',
    venue: 'Trend Research',
    finding: 'Introduces the RSI, ATR and ADX: momentum, volatility and trend-strength measures still in standard use.',
  },
  ca09: {
    id: 'ca09',
    cite: 'Connors & Alvarez (2009)',
    title: 'Short Term Trading Strategies That Work',
    venue: 'TradingMarkets',
    finding: 'Buying extreme short-term oversold readings (2-period RSI under 10) in an uptrend, and selling the overbought, earns short-term reversal returns.',
  },
  bol01: {
    id: 'bol01',
    cite: 'Bollinger (2001)',
    title: 'Bollinger on Bollinger Bands',
    venue: 'McGraw-Hill',
    finding: 'Bands two standard deviations around a moving average mark statistically unusual prices; band breaks signal expansion.',
  },
  app05: {
    id: 'app05',
    cite: 'Appel (2005)',
    title: 'Technical Analysis: Power Tools for Active Investors',
    venue: 'FT Prentice Hall',
    finding: 'The MACD: the gap between fast and slow exponential averages, and its signal line, as a trend and momentum measure.',
  },
  faith07: {
    id: 'faith07',
    cite: 'Faith (2007)',
    title: 'Way of the Turtle',
    venue: 'McGraw-Hill',
    finding: 'The Turtle rules: 20- and 55-day channel breakouts with ATR stops, the classic trend-following system.',
  },
  lmsw02: {
    id: 'lmsw02',
    cite: 'Llorente, Michaely, Saar & Wang (2002)',
    title: 'Dynamic volume-return relation of individual stocks',
    venue: 'Review of Financial Studies 15(4)',
    finding: 'Returns on high volume continue when the volume comes from informed trading and reverse when it comes from hedging.',
  },
  beo94: {
    id: 'beo94',
    cite: 'Blume, Easley & O’Hara (1994)',
    title: 'Market statistics and technical analysis: the role of volume',
    venue: 'Journal of Finance 49(1)',
    finding: 'Volume carries information about the quality of price signals that prices alone do not.',
  },
  gkx20: {
    id: 'gkx20',
    cite: 'Gu, Kelly & Xiu (2020)',
    title: 'Empirical asset pricing via machine learning',
    venue: 'Review of Financial Studies 33(5)',
    finding: 'Regression trees and neural networks forecast returns better than linear models, mostly through nonlinear interactions of momentum, liquidity and volatility signals.',
  },
  bre01: {
    id: 'bre01',
    cite: 'Breiman (2001)',
    title: 'Random forests',
    venue: 'Machine Learning 45',
    finding: 'Averaging many decorrelated decision trees grown on bootstrap samples gives accurate, robust classifiers with honest out-of-bag error.',
  },
  bcgl19: {
    id: 'bcgl19',
    cite: 'Baur, Cahill, Godfrey & Liu (2019)',
    title: 'Bitcoin time-of-day, day-of-week and month-of-year effects in returns and trading volume',
    venue: 'Finance Research Letters 31',
    finding: 'Bitcoin volume and volatility follow the trading day of the major markets; return seasonality is weak.',
  },
  // the statistics that keep the Lab honest
  blp12: {
    id: 'blp12',
    cite: 'Bailey & López de Prado (2012)',
    title: 'The Sharpe ratio efficient frontier',
    venue: 'Journal of Risk 15(2)',
    finding: 'The probabilistic Sharpe ratio: the chance a measured Sharpe beats a benchmark, given sample length, skewness and fat tails.',
  },
  blp14: {
    id: 'blp14',
    cite: 'Bailey & López de Prado (2014)',
    title: 'The deflated Sharpe ratio: correcting for selection bias, backtest overfitting and non-normality',
    venue: 'Journal of Portfolio Management 40(5)',
    finding: 'After trying N strategies, the best Sharpe must clear the expected maximum of N lucky ones; the deflated Sharpe ratio measures that.',
  },
  bblz17: {
    id: 'bblz17',
    cite: 'Bailey, Borwein, López de Prado & Zhu (2017)',
    title: 'The probability of backtest overfitting',
    venue: 'Journal of Computational Finance 20(4)',
    finding: 'Combinatorially symmetric cross-validation estimates how often the in-sample best strategy lands below the median out of sample.',
  },
  hlz16: {
    id: 'hlz16',
    cite: 'Harvey, Liu & Zhu (2016)',
    title: '…and the cross-section of expected returns',
    venue: 'Review of Financial Studies 29(1)',
    finding: 'With hundreds of factors tried, a new one needs a t-statistic above about 3, not 2.',
  },
  nw87: {
    id: 'nw87',
    cite: 'Newey & West (1987)',
    title: 'A simple, positive semi-definite, heteroskedasticity and autocorrelation consistent covariance matrix',
    venue: 'Econometrica 55(3)',
    finding: 'Standard errors that stay honest when returns are autocorrelated and their variance changes.',
  },
  lp18: {
    id: 'lp18',
    cite: 'López de Prado (2018)',
    title: 'Advances in Financial Machine Learning',
    venue: 'Wiley',
    finding: 'Meta-labelling: a secondary model learns when a primary strategy’s signals are worth taking, improving precision without changing the strategy.',
  },
  pr94: {
    id: 'pr94',
    cite: 'Politis & Romano (1994)',
    title: 'The stationary bootstrap',
    venue: 'Journal of the American Statistical Association 89(428)',
    finding: 'Resampling blocks of random length keeps the dependence in a time series when simulating its distribution.',
  },
};

export const paper = (id: string): Paper => PAPERS[id];
