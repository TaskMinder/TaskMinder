import { Request, Response, NextFunction } from "express";
import blockService from "../services/block.service.js";

export const addBlock = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await blockService.addBlock(req.body, req.session);
    res.sendStatus(200);
  }
  catch (error) {
    next(error);
  }
};

export const getBlocks = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const blocks = await blockService.getBlocks(req.session);
    res.status(200).json(blocks);
  }
  catch (error) {
    next(error);
  }
};

export const deleteBlock = async (req: Request<{ accountId: string }>, res: Response, next: NextFunction): Promise<void> => {
  try {
    await blockService.deleteBlock({ accountId: Number(req.params.accountId) }, req.session);
    res.sendStatus(200);
  }
  catch (error) {
    next(error);
  }
};

export default {
  addBlock,
  getBlocks,
  deleteBlock
};
