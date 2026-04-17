import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import adminRouter from "./admin";
import documentsRouter from "./documents";
import conversationsRouter from "./conversations";
import storageRouter from "./storage";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(adminRouter);
router.use(documentsRouter);
router.use(conversationsRouter);
router.use(storageRouter);

export default router;
