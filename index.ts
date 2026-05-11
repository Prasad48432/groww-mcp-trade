import {
  GrowwAPI,
  Exchange,
  Segment,
  Product,
  OrderType,
  TransactionType,
  Validity,
} from "growwapi";

const groww = new GrowwAPI();

const holdings = await groww.holdings.list();
console.log("Holdings:", holdings);

const orderDetails = {
  tradingSymbol: "RELIANCE",
  quantity: 1,
  price: 2800,
  triggerPrice: 0,
  validity: Validity.Day,
  exchange: Exchange.NSE,
  segment: Segment.CASH,
  product: Product.CNC,
  orderType: OrderType.Limit,
  transactionType: TransactionType.Buy,
};

const order = await groww.orders.create(orderDetails);
console.log("Order placed successfully:", order);
