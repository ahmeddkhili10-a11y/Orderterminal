// The terms a buyer of the commercial edition accepts on first launch (and that
// the Windows installer shows). Raise TERMS_VERSION in edition.ts when they
// change, so every copy asks again.

export const TERMS_TITLE = 'Novus Ordo — Licence Agreement and Risk Disclosure';

export const TERMS: { h: string; p: string[] }[] = [
  {
    h: '1. Who this is between',
    p: [
      'Novus Ordo ("the Software") is designed and constructed by Quincy Gininda ("the Author"). This agreement is between the Author and you, the person who bought a licence ("you"). By installing, activating or using the Software you accept it. If you do not accept it, do not use the Software and ask for a refund within the refund period stated where you bought it.',
    ],
  },
  {
    h: '2. Your licence',
    p: [
      'You receive a personal, non-exclusive, non-transferable licence to install and use the Software on up to three computers that you own or control, for as long as your licence remains valid.',
      'You may not copy, share, resell, rent, sublicense or publish the Software or your licence key; remove or change its credits, notices or branding; or decompile, reverse-engineer or modify it, except where the law of your country allows this despite this agreement.',
      'The Software, its name, its emblem, its design and its documentation remain the property of the Author. A licence is not a sale of the Software itself.',
      'A licence that was refunded, charged back or obtained by fraud ends, and the Software stops working on it.',
    ],
  },
  {
    h: '3. Not financial advice',
    p: [
      'The Software is a tool for analysing markets, testing ideas and placing orders that you choose to place. Nothing in it — no chart, forecast, verdict, signal, backtest, ranking, "proven" strategy, bot, swarm or report — is financial, investment, tax or legal advice, or a recommendation to buy, sell or hold anything. You make your own decisions and are solely responsible for them.',
    ],
  },
  {
    h: '4. The risks of trading',
    p: [
      'Trading cryptocurrencies, perpetual futures and other leveraged products carries a high risk of losing money rapidly. You can lose more than you expect, and with leverage you can lose your whole deposit. Only trade money you can afford to lose.',
      'Past performance does not predict future results. Backtests, simulations, forward tests and the checks in the Software reduce the chance of being misled by luck; they do not remove it. Markets change, and a strategy that worked can stop working.',
      'Automated trading (bots, the crypto swarm, deployed strategies) can place orders without you watching. Software, exchanges, networks and data feeds can fail, lag, be wrong or be unavailable, and orders may fill at worse prices than shown, or not at all. Use paper (simulated) mode first, start small, and keep an eye on anything that trades live.',
    ],
  },
  {
    h: '5. Your keys, accounts and data',
    p: [
      'You connect your own exchange accounts, wallets and services. Your keys are kept encrypted on your own computer; the Author never receives them. You are responsible for keeping your computer, your ledger key, your licence key and your accounts secure, for the permissions you give each key (never give a trading key withdrawal rights), and for complying with the terms of every exchange and service you connect.',
      'You are responsible for making sure that using the Software, and trading, is legal where you live, and for any taxes on your trading.',
    ],
  },
  {
    h: '6. No warranty',
    p: [
      'The Software is provided "as is" and "as available", without warranties of any kind, express or implied, including merchantability, fitness for a particular purpose, accuracy and non-infringement. The Author does not warrant that it is free of errors, that it will run without interruption, or that any data, calculation or result is correct.',
    ],
  },
  {
    h: '7. Limitation of liability',
    p: [
      'To the fullest extent the law allows, the Author is not liable for any loss or damage arising from the use of, or inability to use, the Software — including trading losses, lost profits, lost data, missed opportunities, or losses caused by exchanges, networks, third-party services, bugs or incorrect data — even if told such loss was possible. Where liability cannot be excluded, the Author\'s total liability is limited to the amount you paid for your licence.',
    ],
  },
  {
    h: '8. Updates, support and changes',
    p: [
      'Updates and support are provided at the Author\'s discretion. Third-party exchanges and data providers can change or withdraw their services, which may stop features from working; this is not a defect of your licence. These terms may be updated with new versions of the Software; continuing to use a new version means accepting its terms.',
    ],
  },
  {
    h: '9. Ending and general terms',
    p: [
      'This licence ends automatically if you break these terms; you must then stop using the Software and delete it. If any part of this agreement is found unenforceable, the rest stays in force. This agreement is governed by the laws of the Republic of South Africa, without prejudice to any consumer protection that the law of your own country gives you.',
    ],
  },
];

/** the whole text, plain (for the installer and for saving) */
export function termsText(): string {
  return [TERMS_TITLE, '', ...TERMS.flatMap((s) => [s.h, ...s.p, ''])].join('\n');
}
