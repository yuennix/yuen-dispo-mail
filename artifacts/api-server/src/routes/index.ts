import { Router, type IRouter } from "express";
import healthRouter from "./health";
import mailRouter from "./mail";
import adminRouter from "./admin";

const router: IRouter = Router();

router.use(healthRouter);
router.use(mailRouter);
router.use(adminRouter);

export default router;
