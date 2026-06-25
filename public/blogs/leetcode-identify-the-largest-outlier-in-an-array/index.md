## 题目描述

给你一个整数数组 `nums`。该数组包含 `n` 个元素，其中 **恰好 **有 `n - 2` 个元素是 **特殊数字 **。剩下的 **两个 **元素中，一个是所有 **特殊数字 **的 **和** ，另一个是 **异常值 **。

**异常值** 的定义是：既不是原始特殊数字之一，也不是表示元素和的那个数。

**注意**，特殊数字、和 以及 异常值 的下标必须 **不同 **，但可以共享 **相同** 的值。

返回 `nums` 中可能的 **最大****异常值**。

 

示例 1：

**输入：** nums = [2,3,5,10]

**输出：** 10

**解释：**

特殊数字可以是 2 和 3，因此和为 5，异常值为 10。

示例 2：

**输入：** nums = [-2,-1,-3,-6,4]

**输出：** 4

**解释：**

特殊数字可以是 -2、-1 和 -3，因此和为 -6，异常值为 4。

示例 3：

**输入：** nums = [1,1,1,1,1,5,5]

**输出：** 5

**解释：**

特殊数字可以是 1、1、1、1 和 1，因此和为 5，另一个 5 为异常值。

 

**提示：**

	- `3 <= nums.length <= 105`

	- `-1000 <= nums[i] <= 1000`

	- 输入保证 `nums` 中至少存在 **一个 **可能的异常值。

## 解法

```java
class Solution {
    public int getLargestOutlier(int[] nums) {
        Arrays.sort(nums);
        int sum = 0;

        // 假设题目数据范围是 [-1000, 1000]，偏移量为 1000
        int[] cnt = new int[2001];
        for (int i = 0; i < nums.length; i++) {
            cnt[nums[i] + 1000]++;
            sum += nums[i];
        }

        int n = nums.length;
        for (int j = n - 1; j >= 0; j--) {
            int target = nums[j]; // 假设 target 是异常值
            int i = sum - target; // 剩余两部分（特殊数字 + 其余数字和）的和

            if (i % 2 == 0) {
                int specialNum = i / 2; // 理论上的特殊数字

                // 1. 严格检查特殊数字是否在 [-1000, 1000] 的有效数据范围内
                if (specialNum >= -1000 && specialNum <= 1000) {
                    int bucketIndex = specialNum + 1000;

                    // 2. 核心修正：如果特殊数字和异常值是同一个数，桶里至少要有2个它
                    if (specialNum == target) {
                        if (cnt[bucketIndex] > 1) {
                            return target;
                        }
                    } else {
                        // 如果不是同一个数，桶里有就能用
                        if (cnt[bucketIndex] > 0) {
                            return target;
                        }
                    }
                }
            }
        }
        return nums[0];



    }
}

```
